'use strict'
process.env['PATH'] = process.env['PATH'] + ':' + process.env['LAMBDA_TASK_ROOT'];

const AWS = require('aws-sdk');
const dynamoEndpoint = process.env.DYNAMO_ENDPOINT;
const sesEndpoint = process.env.SES_ENDPOINT;
const snsEndpoint = process.env.SNS_ENDPOINT;
const dynamo = new AWS.DynamoDB.DocumentClient({endpoint: dynamoEndpoint, apiVersion: '2012-08-10'});
const ses = new AWS.SES({endpoint: sesEndpoint, apiVersion: '2010-12-01', region: 'us-east-1'});
const sns = new AWS.SNS({endpoint: snsEndpoint, apiVersion: '2010-03-31', region: 'us-east-1'});

const moment = require('moment');
const todayYMD = +moment().format('YYYYMMDD');

const groupsTable = process.env.GROUPS_TABLE;
const groupMsgsTable = process.env.GROUP_MSGS_TABLE;
const usersTable = process.env.USERS_TABLE;
const userDataTable = process.env.USER_DATA_TABLE;
const reminderMsgsTable = process.env.REMINDER_MSGS_TABLE;
const emailSender = 'uscemotioncognitionlab@gmail.com';
const targetMinutesByWeek = JSON.parse(process.env.TARGET_MINUTES_BY_WEEK);
const DEFAULT_TARGET_MINUTES = 20;

const NEW_MSG_MINUTES = 120; //group messages younger than this are new
const NEW_EMOJI_MINUTES = 120; //emojis younger than this are new

const validMsgTypes = ['train', 'report', 'group_ok', 'group_behind', 'new_group_msg', 'new_emoji'];

exports.handler = (event, context, callback) => {
    const msgType = event.msgType;
    if (validMsgTypes.indexOf(msgType) === -1) {
        callback(new Error(`${msgType} is not a valid message type`));
        return;
    }

    const emailPromises = [];
    const phonePromises = [];
    const recipients = [];
    // function for selecting msg recipients
    // it must return a Promise<[{msg: msg obj, recipients: [user obj]}]>
    // where the msg obj is a record from the hrv-reminder-msgs table and the user obj from hrv-users
    let getRecipients;

    // choose the recipient selection function based on the msgType
    switch (msgType) {
        case 'train': {
            getRecipients = getUsersToBeReminded;
            break;
        }
        case 'report': {
            getRecipients = getUsersMissingReporting;
            break;
        }
        case 'new_group_msg': {
            getRecipients = getUsersInGroupsWithNewMessages;
            break;
        }
        case 'new_emoji': {
            getRecipients = getUsersWithNewEmoji;
            break;
        }
    }
    
    getRecipients()
    .then((results) => {
        results.forEach((msgAndRecips) => {
            const msg = msgAndRecips.msg;
            const users = msgAndRecips.recipients;
            users.forEach(u => {
                const contact = u.email || u.phone;
                recipients.push({recip: contact, msg: msg.id});
                if (contact.indexOf('@') !== -1) {
                    emailPromises.push(sendEmail(contact, msg));
                } else {
                    phonePromises.push(sendSMS(contact, msg));
                }
            });
        });
        const allPromises = emailPromises.concat(phonePromises);

        // may need to make sure one failure doesn't stop other sends from executing
        // https://stackoverflow.com/questions/31424561/wait-until-all-es6-promises-complete-even-rejected-promises
        // https://davidwalsh.name/promises-results
        // theoretically the catches at the end of sendSMS and sendEmail should take care of this, though
        return Promise.all(allPromises);
    })
    .then(() => callback(null, JSON.stringify(recipients)))
    .catch((err) => console.log(err))
}

/**
 * Sends msg to one phone number.
 * @param {string} The e164 formatted phone number we're sending the message to 
 * @param {object} msg An object with an sms field containing the text we're sending
 */
function sendSMS(recip, msg) {
    const params = {
        Message: msg.sms,
        PhoneNumber: recip,
        MessageAttributes: {
            'AWS.SNS.SMS.SMSType': {
                DataType: 'String',
                StringValue: 'Transactional'
            }
        }
    }
    return sns.publish(params).promise().catch(err => {
        console.log(`Error sending sms to ${recip}. (Message: ${msg.sms})`);
        console.log(err);
    });
}

/**
 * Sends email message msg to a single recipient
 * @param {string} recip Email address of the recipient
 * @param {object} msg msg object with html, text, subject fields
 */
function sendEmail(recip, msg) {
    const params = {
        Destination: {
            ToAddresses: [recip]
        },
        Message: {
            Body: {
                Html: {
                    Charset: "UTF-8",
                    Data: msg.html
                },
                Text: {
                    Charset: "UTF-8",
                    Data: msg.text
                }
            },
            Subject: {
                Charset: "UTF-8",
                Data: msg.subject
            }
        },
        Source: emailSender
    }
    return ses.sendEmail(params).promise().catch(err => {
        console.log(`Error sending email to ${recip}. (Message: ${msg.text})`);
        console.log(err);  
    });
}

// Returns Promise<[{msg: msg obj, recipients: [user obj]}]>
// for users who need to be reminded to do their training today
function getUsersToBeReminded() {
    let userMap;
    return getActiveGroupsAndUsers()
    .then((result) => getUsersWhoHaveNotCompletedTraining(result.userMap, result.groupMap))
    .then((recipientMap) => {
        userMap = recipientMap;
        return getRandomMsgForType('train');
    })
    .then((msg) => [{ msg: msg, recipients: Array.from(userMap.values()) }]);
}

/**
 * Returns a Promise<[{msg: msg obj, recipients: [user obj]}]> of users in active groups who failed to report any minutes yesterday.
 */
function getUsersMissingReporting() {
    let userMap;
    return getActiveGroupsAndUsers()
    .then((result) => getUsersWithoutReports(result.userMap, result.groupMap))
    .then((recipientMap) => {
        userMap = recipientMap;
        return getRandomMsgForType('report');
    })
    .then((msg) => [{ msg: msg, recipients: Array.from(userMap.values()) }]);
}

/**
 * Returns Promise<[{msg: msg obj, recipients: [user obj]}]> of users in groups that have new messages
 */
function getUsersInGroupsWithNewMessages() {
    let users;
    return getActiveGroups()
    .then((groupsResult) => groupsResult.Items.map(g => g.name))
    .then((activeGroups) => {
        if (activeGroups.length > 100) throw new Error('Too many groups! No more than 100 are allowed.');

        const newLimit = +moment().subtract(NEW_MSG_MINUTES, 'minutes').format('x');
        const attrVals = {}
        attrVals[':newLimit'] = newLimit;
        activeGroups.forEach((g, idx) => {
            attrVals[':val'+idx] = g;
        });
        const groupAndTimeConstraint = `#G in (${Object.keys(attrVals).join(', ')}) and #D >= :newLimit`;
        const params = {
            TableName: groupMsgsTable,
            ExpressionAttributeNames: {
                '#G': 'group',
                '#D': 'date'
            },
            ExpressionAttributeValues: attrVals,
            FilterExpression: groupAndTimeConstraint,
            ProjectionExpression: '#G'
        }
        return dynamo.scan(params).promise();
    })
    .then((groupsWithNewMsgsResult) => getUsersInGroups(groupsWithNewMsgsResult.Items.map(gm => gm.group)))
    .then(usersResult => {
        users = usersResult.Items;
        return getRandomMsgForType('new_group_msg');
    })
    .then((msg) => [{ msg: msg, recipients: users }]);
}

/**
 * Returns Promise<[{msg: msg obj, recipients: [user obj]}]> of users with new emoji
 */
function getUsersWithNewEmoji() {
    // TODO restrict query to users in active groups
    let users;
    const params = {
        TableName: userDataTable,
        FilterExpression: '#D = :today and attribute_exists(emoji)',
        ExpressionAttributeNames: { '#D': 'date' },
        ExpressionAttributeValues: { ':today': todayYMD }
    }
    return dynamo.scan(params).promise()
    .then((results) => {
        const newEmojiLimit = +moment().subtract(NEW_EMOJI_MINUTES, 'minutes').format('x');
        const users = new Set();
        results.Items.filter(i => i.emoji.findIndex(em => em.datetime >= newEmojiLimit) !== -1)
        .forEach(i => users.add(i.userId));
        return users;
    })
    .then((users) => {
        if (users.size > 100) throw new Error('Too many users have new emojis in the past two hours - only 100 can be handled.')
        
        const keys = [];
        users.forEach(u => keys.push({id: u}));
        const params = { RequestItems: {} };
        params.RequestItems[usersTable] = { Keys: keys };
        return dynamo.batchGet(params).promise()
    })
    .then((usersResult) => {
        users = usersResult.Responses[usersTable];
        return getRandomMsgForType('new_emoji');
    })
    .then((msg) => [{ msg: msg, recipients: users }]);
}

/**
 * Returns Promise<{userMap:Map, groupMap: Map}>, where userMap maps user id -> user obj
 * and groupMap group name -> group obj.
 */
function getActiveGroupsAndUsers() {
    // map of group name -> group object
    const groupMap = new Map();
    // map of user id -> user object
    const userMap = new Map();

    return getActiveGroups()
    .then((groupsResult) => {
        groupsResult.Items.forEach((g) => groupMap.set(g.name, g));
        return Array.from(groupMap.keys());
    })
    .then((groupNames) => {
        return getUsersInGroups(groupNames)
    })
    .then((usersResult) => {
        usersResult.Items.forEach((u) => {
            u.contact = u.email || u.phone;
            userMap.set(u.id, u);
        });
        return { userMap: userMap, groupMap: groupMap };
    });
}

// Returns a promise of scan output with names of groups whose startDate is on or before today
// and whose endDate is on or after_today
function getActiveGroups() {
    const params = {
        TableName: groupsTable,
        ExpressionAttributeValues: {
            ':td': todayYMD
        },
        FilterExpression: "startDate <= :td AND endDate >= :td"
    }
    return dynamo.scan(params).promise();
}

// Given a list of groups, returns promise of scan output with users
// who are members of those groups
// TODO handle >100 groups
function getUsersInGroups(groups) {
    if (groups.length > 100) throw new Error('Too many groups! No more than 100 are allowed.');
    const attrVals = {}
    groups.forEach((g, idx) => {
        attrVals[':val'+idx] = g;
    });
    const groupConstraint = '#G in (' + Object.keys(attrVals).join(', ') + ')';
    const params = {
        TableName: usersTable,
        ExpressionAttributeNames: {
            '#G': 'group'
        },
        ExpressionAttributeValues: attrVals,
        FilterExpression: groupConstraint,
        ProjectionExpression: 'id, email, #G, phone, firstName, lastName'
    }
    return dynamo.scan(params).promise();
}


/**
 * Given a start date, returns the number of minutes that a user in a 
 * group with that start date should have spent training today.
 * @param {number} startDate 
 */
function getTargetMinutes(startDate) {
    const today = moment();
    const startMoment = moment(startDate.toString());
    const weekNum = Math.floor(today.diff(startMoment, 'days') / 7);
    if (weekNum < 0 || weekNum > targetMinutesByWeek.length - 1) {
        return DEFAULT_TARGET_MINUTES;
    }
    return targetMinutesByWeek[weekNum];
}

// returns promise of map of id->user object for all users who have not
// completed their training for today
function getUsersWhoHaveNotCompletedTraining(userMap, groupMap) {
    // pull training data for today
    const params = {
        TableName: userDataTable,
        ExpressionAttributeNames: {
            '#D': 'date'
        },
        ExpressionAttributeValues: {
            ':today': todayYMD
        },
        FilterExpression: '#D = :today',
        ProjectionExpression: 'userId, minutes'
    }

    return dynamo.scan(params).promise()
    .then(userData => {
        userData.Items.forEach(ud => {
            const activeUser = userMap.get(ud.userId);
            if (activeUser !== undefined) { // undefined means we have training data for them today but they're not in an active group, which shouldn't happen
                const groupObj = groupMap.get(activeUser.group);
                if (ud.minutes >= getTargetMinutes(groupObj.startDate)) {
                    userMap.delete(ud.userId);
                }
            }
        });
        return userMap;
    });
}

/**
 * 
 * @param {Map} userMap user id -> user contact (email or phone) map
 * @param {Map} groupMap group id -> group object map
 */
function getUsersWithoutReports(userMap, groupMap) {
    const yesterdayYMD = +moment().subtract(1, 'days').format('YYYYMMDD');
    const params = {
        TableName: userDataTable,
        ExpressionAttributeNames: { '#D': 'date' },
        ExpressionAttributeValues: { ':yesterday': yesterdayYMD },
        FilterExpression: '#D = :yesterday and attribute_exists(minutes)',
    }

    return dynamo.scan(params).promise()
    .then(userData => {
        userData.Items.forEach(ud => {
            userMap.delete(ud.userId);
        });
        return userMap;
    });
}

/**
 * Returns a Promise<obj> of a randomly selected active message of type msgType
 * @param {string} msgType The type of message you want
 */
function getRandomMsgForType(msgType) {
    const params = {
        TableName: reminderMsgsTable,
        FilterExpression: 'active = :true and msgType = :msgType',
        ExpressionAttributeValues: {':true': true, ':msgType': msgType }
    }
    return dynamo.scan(params).promise()
    .then(result => {
        if (result.Items.length === 0) throw new Error(`Found no active messages of type ${msgType}`)
        const rand = Math.round(Math.random() * (result.Items.length - 1));
        return result.Items[rand];
    });
}
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/take';
import { Router, Resolve, RouterStateSnapshot,
         ActivatedRouteSnapshot } from '@angular/router';

import { User } from '../model/user';
import { GroupPage } from '../model/group-page';
import { GroupService } from './group.service';

@Injectable()
export class GroupResolverService implements Resolve<GroupPage> {

    constructor(private groupService: GroupService, private router: Router) { }

    resolve(route: ActivatedRouteSnapshot, state: RouterStateSnapshot): Observable<GroupPage> {
        let groupName = route.paramMap.get('group_name');
        return this.groupService.getGroupMembers(groupName).take(1)
        .flatMap(members => {
            if (groupName === null) {
                groupName = members[0].group;
            }
            return Observable.fromPromise(this.groupService.getGroup(groupName))
            .map(group => {
                return {members: members, group: group};
            });
        })
        .flatMap(groupPage => {
            return this.groupService.getGroupMessages(0, groupName).take(1)
            .map(msgs => {
                return { members: groupPage.members, messages: msgs, group: groupPage.group };
            });
        });
    }
}

import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';

import 'rxjs/add/operator/switchMap';
import { Observable } from 'rxjs/Observable';

import { EmojiFeedback } from './model/emoji-feedback';
import { GroupMessage } from './model/group-message';
import { User } from './model/user';

import { GroupService } from './service/group.service';

@Component({
    selector: 'app-group-page',
    template: `
    <div class="container">
        <h2>Teammates</h2>
        <app-user *ngFor="let user of members" [user]=user [doneRatio]=85></app-user>
        <hr />
        <h2>Messages</h2>
        <div class="form-group">
            <form (ngSubmit)="sendGroupMsg()" #msgForm="ngForm">
                <div style="float: left;">
                    <textarea rows="2" cols="40" name="msgText" required #msg="ngModel" [(ngModel)]="msgText" type="textarea" class="group-msg-txt" placeholder="Send a message to the rest of the group"></textarea>
                </div>
                <button class="btn msg-text-btn" [disabled]="!msgForm.form.valid" type="submit">Submit</button>
            </form>
        </div>
        <div *ngFor="let msg of messages">
            {{msg.date}} <br/>
            {{userNameForId(msg.fromId)}}<br/>
            {{msg.body}}
        </div>
    </div>
    `
})

export class GroupPageComponent implements OnInit {
    name: string;
    members: User[];
    messages: GroupMessage[] = [];
    msgText: string;

    constructor(private groupService: GroupService, private route: ActivatedRoute, private router: Router) { }

    ngOnInit() {
        this.route.data
        .subscribe((data: { members: User[] }) => {
            this.members = data.members;
        });
        this.name = this.route.snapshot.paramMap.get('name');
    }

    sendGroupMsg() {
        const msg = new GroupMessage(this.msgText.trim());
        this.groupService.createGroupMessage(msg, this.name).subscribe(savedMsg => {
            this.messages.push(savedMsg);
        });
    }

    private userNameForId(userId: string): string | undefined {
        const member = this.members.find((u) => u.id === userId);
        return member === undefined ? undefined : member.name();
    }
}

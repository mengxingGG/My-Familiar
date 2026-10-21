import type {GithubAuthStatus} from '../contracts/github-auth.ts';
export interface MobileGithubAuth extends GithubAuthStatus {applied:boolean;targetRevision:string;}
export interface MobileGithubCommands {
 'github.auth.status':{params:undefined;result:MobileGithubAuth};
 'github.auth.configure':{params:{revision:string;clientId:string};result:MobileGithubAuth};
 'github.auth.begin':{params:{revision:string};result:MobileGithubAuth};
 'github.auth.open':{params:{revision:string};result:MobileGithubAuth};
 'github.auth.cancel':{params:{revision:string};result:MobileGithubAuth};
 'github.auth.forget':{params:{revision:string};result:MobileGithubAuth};
 'github.auth.apply':{params:{revision:string;targetRevision:string;readOnly:boolean;enabled:boolean};result:MobileGithubAuth};
}

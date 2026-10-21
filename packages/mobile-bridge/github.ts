import {MobileBridgeError,type MobileGithubAuth} from '../mobile-contracts/index.ts';
export function projectGithubAuth(v:any):MobileGithubAuth{
 const valid=!!v&&typeof v==='object'&&/^[a-f0-9-]{36}$/.test(v.revision)&&typeof v.clientId==='string'&&v.clientId.length<=100&&typeof v.connected==='boolean'&&typeof v.applied==='boolean'&&/^[a-f0-9]{64}$/.test(v.targetRevision)&&
 ['signedOut','saving','authorizing','connected','refreshing','error'].includes(v.phase)&&typeof v.detail==='string'&&v.detail.length<=1000&&(v.configurationError===undefined||typeof v.configurationError==='boolean')&&Array.isArray(v.scopes)&&v.scopes.length<=100&&v.scopes.every((s:unknown)=>typeof s==='string'&&/^[a-zA-Z0-9_:-]{1,100}$/.test(s))&&
 (v.user===undefined||v.user&&typeof v.user==='object'&&Number.isSafeInteger(v.user.id)&&v.user.id>0&&typeof v.user.login==='string'&&/^[A-Za-z0-9-]{1,100}$/.test(v.user.login))&&
 (v.authorization===undefined||v.authorization&&typeof v.authorization==='object'&&v.authorization.url==='https://github.com/login/device'&&typeof v.authorization.userCode==='string'&&/^[A-Z0-9-]{6,32}$/.test(v.authorization.userCode)&&Number.isSafeInteger(v.authorization.expiresAt)&&v.authorization.expiresAt>0);
 if(!valid)throw new MobileBridgeError('UNAVAILABLE','GitHub 登录状态不兼容');
 return {revision:v.revision,clientId:v.clientId,connected:v.connected,applied:v.applied,targetRevision:v.targetRevision,phase:v.phase,detail:v.detail,...(v.configurationError===true?{configurationError:true}:{}),scopes:[...v.scopes],...(v.user?{user:{id:v.user.id,login:v.user.login}}:{}),...(v.authorization?{authorization:{url:v.authorization.url,userCode:v.authorization.userCode,expiresAt:v.authorization.expiresAt}}:{})};
}

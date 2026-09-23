'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {once}=require('node:events');
const {buildRoadmap,simplifySentence}=require('../src/clarity');
const {hashPassword,verifyPassword}=require('../src/auth');

test('formal wording becomes plain language',()=>{
 assert.match(simplifySentence('You are required to furnish documentation prior to 20 September 2026.'),/must provide documents before/i);
});
test('roadmap detects actions, requirements and dates',()=>{
 const result=buildRoadmap('You must submit your ID copy and proof of address by 20 September 2026. Email files to team@example.org. Reference number: APP-20491.','Application');
 assert.ok(result.steps.length>=1);
 assert.equal(result.deadlines[0].iso,'2026-09-20');
 assert.ok(result.requirements.some(x=>/proof of address/i.test(x)));
 assert.equal(result.contacts.emails[0],'team@example.org');
 assert.ok(result.references.includes('APP-20491'));
});
test('password hashing verifies only the correct password',()=>{
 const hash=hashPassword('correct-horse-battery');
 assert.ok(verifyPassword('correct-horse-battery',hash));
 assert.equal(verifyPassword('wrong',hash),false);
});
test('API can register, sign in and save user-specific documents',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'papercut-test-'));
 process.env.PAPERCUT_DB=path.join(temp,'db.sqlite');
 const {server,db}=require('../server');
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const json=async(method,url,data,token)=>{
   const response=await fetch(base+url,{
     method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
     ...(data?{body:JSON.stringify(data)}:{})
   });
   return {status:response.status,data:await response.json()};
 };
 try {
   const health=await json('GET','/api/health');
   assert.equal(health.status,200);
   const signup=await json('POST','/api/auth/signup',{name:'Morgan',email:'morgan@example.org',password:'secure-passphrase'});
   assert.equal(signup.status,200);
   assert.ok(signup.data.token);
   const token=signup.data.token;
   const doc=await json('POST','/api/documents',{title:'Application',text:'You must submit your ID copy and proof of address by 20 September 2026.'},token);
   assert.equal(doc.status,200);
   assert.equal(doc.data.document.title,'Application');
   const unauth=await json('GET','/api/documents');
   assert.equal(unauth.status,401);
   const mine=await json('GET','/api/documents',null,token);
   assert.equal(mine.data.documents.length,1);
   const signin=await json('POST','/api/auth/signin',{email:'morgan@example.org',password:'secure-passphrase'});
   assert.equal(signin.status,200);
 } finally {
   await new Promise(resolve=>server.close(resolve));
   db.close();
   fs.rmSync(temp,{recursive:true,force:true});
 }
});

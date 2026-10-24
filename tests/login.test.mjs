import test from 'node:test';
import assert from 'node:assert/strict';
import login from '../api/login.mjs';

function reply(){return {setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
function request(email){return {method:'POST',headers:{'content-type':'application/json'},body:{email}};}

test('login validates its protocol and never sends to an unapproved address',async()=>{
 const previous={...process.env},originalFetch=globalThis.fetch;let calls=0;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-test',LABGUARD_ALLOWED_EMAILS:'pilot@example.test'});
  globalThis.fetch=async()=>{calls++;throw new Error('Provider must not be called');};
  for(const [req,status] of [[{method:'GET',headers:{}},405],[{method:'POST',headers:{'content-type':'text/plain'}},415],[request('invalid'),400],[request('outsider@example.test'),200]]){
   const res=reply();await login(req,res);assert.equal(res.code,status);
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
test('only an allowlisted address can bootstrap a first magic-link login',async()=>{
 const previous={...process.env},originalFetch=globalThis.fetch;let sent;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-test',LABGUARD_ALLOWED_EMAILS:'pilot@example.test'});
  globalThis.fetch=async(url,options)=>{sent={url,body:JSON.parse(options.body)};return {ok:true};};
  const res=reply();await login(request(' PILOT@EXAMPLE.TEST '),res);
  assert.equal(res.code,200);assert.equal(sent.body.email,'pilot@example.test');assert.equal(sent.body.create_user,true);
  assert.equal(new URL(sent.url).searchParams.get('redirect_to'),'https://armeng-labguard.vercel.app/');
  assert.equal(JSON.stringify(res.body).includes('pilot@example.test'),false);
 }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});
test('provider failures do not falsely claim that an email was sent',async()=>{
 const previous={...process.env},originalFetch=globalThis.fetch;
 try{
  Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-test',LABGUARD_ALLOWED_EMAILS:'failure@example.test'});
  globalThis.fetch=async()=>({ok:false,status:429});const res=reply();await login(request('failure@example.test'),res);
  assert.equal(res.code,429);assert.ok(res.body.error);assert.equal(res.body.message,undefined);
 }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const host = new URL('../../client/client.js', import.meta.url);
test('custom panel draft updates reach the shared host draft and preserve other configuration', {skip: !existsSync(host)},()=>{
  const code=readFileSync(host,'utf8');const start=code.indexOf('function ExtPage(');assert.ok(start>=0);
  let pd=0,body=-1;
  for(let i=code.indexOf('(',start);i<code.length;i++){const c=code[i];if(c==='(')pd++;else if(c===')'){pd--;if(!pd){body=code.indexOf('{',i);break}}}
  let end=-1,depth=0,q=null;
  for(let i=body;i<code.length;i++){const c=code[i],n=code[i+1];
    if(q){if(c==='\\'){i++;continue}if(c===q)q=null;continue}
    if(c==='"'||c==="'"||c==='`')q=c;
    else if(c==='/'&&n==='/'){while(i<code.length&&code[i]!=='\n')i++}
    else if(c==='/'&&n==='*'){i=code.indexOf('*/',i)+1}
    else if(c==='{')depth++;
    else if(c==='}'){depth--;if(!depth){end=i+1;break}}
  }
  assert.ok(body>start&&end>body);
  const h=(type,props,...children)=>({type,props,children});
  const ExtPage=new Function('useField','h','Empty','Card','Row','ExtPanel','return ('+code.slice(start,end)+')')(()=>({}),h,'Empty','Card','Row','ExtPanel');
  let draft={enabled:true,ext:{'tieba-reader':{bars:'old',cookie:''},other:{keep:true}}};const saved=structuredClone(draft);
  const tree=ExtPage({st:{config:saved,modules:[{id:'tieba-reader',defaults:{enabled:true},settings:[],panel:true}]},draft,setDraft:updater=>{draft=updater(draft);},toast(){},reload(){},mod:'tieba-reader'});
  const child=tree.children.find(n=>n&&n.type==='ExtPanel');assert.ok(child);assert.equal(child.props.draftSettings.bars,'old');
  child.props.setSettings({bars:'new'});assert.equal(draft.ext['tieba-reader'].bars,'new');assert.equal(saved.ext['tieba-reader'].bars,'old');assert.equal(draft.ext.other.keep,true);
  assert.notEqual(JSON.stringify(draft),JSON.stringify(saved));
});

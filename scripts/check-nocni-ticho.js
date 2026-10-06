const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {vytvor}=require('../nocni-ticho');
const d=fs.mkdtempSync(path.join(os.tmpdir(),'t-'));
const at=(h,m=0)=>Date.parse(`2026-10-06T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+02:00`);
let t=at(12); const z=vytvor(d,()=>t);
assert.equal(z.brana('den'),'poslat');
t=at(22); assert.equal(z.brana('noc1'),'fronta');
t=at(3); assert.equal(z.brana('noc2'),'fronta');
z.ondraNapsal(); t=at(3,5); assert.equal(z.brana('odpoved'),'poslat');
t=at(3,11); assert.equal(z.brana('pozde'),'fronta');
(async()=>{
 const out=[]; t=at(6,59); assert.equal(await z.vyprazdni(async x=>out.push(x)),false);
 t=at(7,1); assert.equal(await z.vyprazdni(async x=>out.push(x)),true);
 assert.equal(out.length,1); assert(out[0].includes('noc1')&&out[0].includes('noc2')&&out[0].includes('pozde')&&!out[0].includes('odpoved'));
 assert.equal(await z.vyprazdni(async x=>out.push(x)),false); assert.equal(out.length,1);
 t=at(23); z.brana('x'); t=at(7,2)+86400000; // selhání odeslání → zůstane
 assert.equal(await z.vyprazdni(async()=>{throw new Error('x')}),false);
 const ok=[]; assert.equal(await z.vyprazdni(async x=>ok.push(x)),true);
 console.log('OK',out[0]);
})();

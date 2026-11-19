const fs=require('fs'), path=require('path');
const ROOT=require('path').join(__dirname,'..','htdocs','luci-static','falcon');

function parse(css){
  css=css.replace(/\/\*[\s\S]*?\*\//g,'');
  const out=[]; let i=0;
  while(i<css.length){
    const b=css.indexOf('{',i); if(b<0)break;
    const pre=css.slice(i,b).trim();
    if(pre.startsWith('@')){ let d=1,j=b+1; while(j<css.length&&d){ if(css[j]==='{')d++; else if(css[j]==='}')d--; j++; } i=j; continue; }
    const c=css.indexOf('}',b+1); if(c<0)break;
    const body=css.slice(b+1,c);
    const decls={};
    body.split(';').forEach(p=>{const k=p.indexOf(':'); if(k>0)decls[p.slice(0,k).trim()]=p.slice(k+1).trim();});
    pre.split(',').map(x=>x.trim()).filter(Boolean).forEach(sel=>{
      const id=(sel.match(/#/g)||[]).length;
      const cls=(sel.match(/\.[\w-]+/g)||[]).length + (sel.match(/\[[^\]]*\]/g)||[]).length;
      const tag=(sel.split(/\s+/).map(t=>t.replace(/^[#.\[]*/,'')[0]).filter(c=>c&&/[a-zA-Z]/.test(c)).length);
      out.push({sel, spec:id*100+cls*10+tag, decls, order:out.length});
    });
    i=c+1;
  }
  return out;
}

let rules=[];
for(const f of ['cascade.css','theme.css']){
  parse(fs.readFileSync(path.join(ROOT,f),'utf8')).forEach(r=>{r.file=f;r.order=rules.length;rules.push(r);});
}

function norm(s){return s.replace(/\s+/g,' ').trim();}

const target=norm(process.argv[2]), prop=process.argv[3];
// 用真实 DOM 路径匹配：目标元素的祖先链是 header > ul.nav > li > ul.dropdown-menu
// 简化：把规则选择器归一后，与目标做后缀匹配
const hits=rules.filter(r=>{
  if(r.decls[prop]==null) return false;
  const rs=norm(r.sel);
  return rs===target || rs.endsWith(' '+target) || target.endsWith(' '+rs) || target.replace(/^.*?\s/,'')===rs;
});

hits.sort((a,b)=> a.spec-b.spec || a.order-b.order);
console.log(`[${prop}] 匹配 "${target}" 的规则:`);
hits.forEach(h=>console.log(`  [spec ${h.spec}] ${h.file.padEnd(12)} ${h.sel} -> ${h.decls[prop]}`));
if(hits.length){
  const w=hits[hits.length-1];
  console.log(`\nWINNER: "${w.decls[prop]}"  (${w.file})`);
}

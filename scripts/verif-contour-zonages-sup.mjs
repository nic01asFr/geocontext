const base="/tmp/gctest/app/node_modules/jsts/org/locationtech/jts/";
await import(base+"monkey.js");
const {default:R}=await import(base+"io/GeoJSONReader.js");
import { empriseIntersects } from "/tmp/gctest/app/dist/emprise.js";
const W="https://data.geopf.fr/wfs/ows";
const j=async(p)=>(await fetch(W+"?"+new URLSearchParams({service:"WFS",version:"2.0.0",request:"GetFeature",outputFormat:"application/json",srsName:"EPSG:4326",...p}))).json();
const com=(await j({typeName:"ADMINEXPRESS-COG.LATEST:commune",CQL_FILTER:"code_insee='13005'"})).features[0].geometry;
const rd=new R(); const C=rd.read(com);
const e=await empriseIntersects("13005","the_geom");
const out={};
for (const [t,tri] of [["wfs_du:zone_urba","gid"],["wfs_sup:assiette_sup_s","gid"]]) {
  const cql=(t.startsWith("wfs_du")?"partition LIKE 'DU_200054807%' AND ":"")+e;
  let tous=[],i=0; for(;;){ const d=await j({typeName:t,CQL_FILTER:cql,count:"1000",startIndex:String(i),sortBy:tri}); tous.push(...d.features); i+=d.features.length; if(!d.features.length||i>=d.numberMatched) break; }
  let dedans=0,cheval=0,hors=0;
  for(const f of tous){ const g=rd.read(f.geometry); if(!C.intersects(g)) hors++; else if(C.contains(g)) dedans++; else cheval++; }
  console.log(t, "lus",tous.length,"gardés",dedans+cheval,"dont cheval",cheval,"écartés",hors);
}

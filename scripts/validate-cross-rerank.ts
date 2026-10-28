import { join } from 'node:path';
import { LocalBgeReranker } from '../src/adapters/rerank/localBgeReranker.js';
const T=1760000000000;
const m=(id,content)=>({id,owner:{kind:'butler',userId:'u'},memClass:'global_shared',kind:'fact',content,confidence:.8,evidence:[],fitness:.8,lifecycle:'active',lastHitAt:T,hitCount:0,revivedCount:0,scope:'global',version:1,createdAt:T,updatedAt:T,useCount:0});
const s=(memory)=>({memory,score:.8,relevance:.8,fitness:.8,confidence:.8,exploratory:false,why:'x'});
const r=new LocalBgeReranker(join(process.cwd(),'.butler-data','models'));
console.log('available',r.isAvailable());
const scores=await r.score('晚饭可以放香菜吗？',[s(m('coffee','用户喜欢喝美式咖啡。')),s(m('cilantro','用户不吃香菜。')),s(m('quiet','用户喜欢安静。'))]);
console.log(scores);

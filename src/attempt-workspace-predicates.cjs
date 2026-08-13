function sha(a,b){return typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();}
function target(a,b){return a?.kind===b?.kind&&a?.number===b?.number;}
function bound(o,r){return o.repository===r.repository&&target(o.target,r.target);}
function seteq(a,b){return a.length===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);}
function findings(a,b){return a.length===b.length&&a.every((v,i)=>JSON.stringify(v)===JSON.stringify(b[i]));}
/** Mirrors decideReviewTransition in ./reviewer-outcome-contract.ts. */
const REPAIR_PROGRESS=new Set(["none","all_resolved"]);
function transition(res){return res.outcome==="approved"?"approve":res.outcome==="changes_requested"&&REPAIR_PROGRESS.has(res.priorRequiredFindings)?"repair":"human_required";}
function marker(m,r,out,output){return !!m&&m.attemptId===r.attemptId&&m.role===r.role&&m.repository===r.repository&&target(m.target,r.target)&&sha(m.inputHead,r.inputRevision.head)&&String(m.inputBase||"").toLowerCase()===String(r.inputRevision.base||"").toLowerCase()&&m.outcome===out&&(output===undefined?m.outputRevision===undefined:sha(m.outputRevision,output));}
/** @param {{record:any,report:any,github:any,context?:Record<string,any>,attemptActive?:boolean}} input */
function evaluateCompletionPersistence(input){
 const {record,report,github}=input;const context=input.context||{};
 if(record.phase==="launch_failed")return{action:"preserve",reason:"launch_failed"};
 if((record.role==="worker"&&record.target?.kind!=="issue")||(record.role!=="worker"&&record.target?.kind!=="pull-request"))return{action:"preserve",reason:"invalid_report"};
 if(report.kind==="missing")return{action:"preserve",reason:input.attemptActive?"active_attempt":"missing_report"};
 if(report.promisePath!==record.promiseFile)return{action:"preserve",reason:"ownership_mismatch"};
 if(report.kind!=="v1")return{action:"preserve",reason:"invalid_report"};
 let r;try{r=require("./attempt-lifecycle-runtime.cjs").validateCompletionReportBinding(record,report.report).report;}catch{return{action:"preserve",reason:"invalid_report"};}
 if(r.status==="blocked")return{action:"preserve",reason:"blocked"};
 if(r.role!=="reviewer"&&(!record.outputRevision||!sha(record.outputRevision,r.result.outputRevision)))return{action:"preserve",reason:"invalid_report"};
 const reviewTransition=r.role==="reviewer"?transition(r.result):undefined;
 if(github.kind!=="confirmed"||github.role!==r.role||!bound(github,record))return{action:"preserve",reason:"github_persistence_not_confirmed"};
 let ok=false;
 if(r.role==="worker"){
  const p=github.pullRequests.filter(x=>bound(x,record)&&x.state==="open"&&x.headBranch===record.branch);
  ok=typeof context.workerReviewLabel==="string"&&p.length===1&&sha(record.outputRevision,r.result.outputRevision)&&sha(p[0].headSha,r.result.outputRevision)&&p[0].baseBranch===record.baseBranch&&p[0].closesIssue===record.target.number&&p[0].labels.includes(context.workerReviewLabel)&&marker(p[0].marker,record,"complete",r.result.outputRevision)&&!github.issueClaimable&&!sha(r.result.outputRevision,record.inputRevision.head);
 } else if(r.role==="reviewer"){
  const p=github.reviewPersistence;const expected=context["reviewerExpectedLabels"];const managed=new Set(context["reviewerManagedLabels"]||expected||[]);ok=sha(github.headSha,record.inputRevision.head)&&Array.isArray(expected)&&seteq(github.labels.filter(x=>managed.has(x)),expected)&&!!p&&bound(p,record)&&sha(p.headSha,record.inputRevision.head)&&marker(p.marker,record,r.result.outcome)&& (reviewTransition!=="repair"||(p.boundedRepairAttemptMarked&&findings(p.findings,r.result.findings||[])));
 } else {
  const out=r.result.outputRevision;const stale=r.result.outcome==="stale_head";
  ok=sha(record.outputRevision,out)&&sha(github.headSha,out)&&!sha(out,record.inputRevision.head)&&(stale?(!github.pushRecorded&&!github.successClaimRecorded):(github.pushRecorded&&github.successClaimRecorded&&marker(github.marker,record,r.result.outcome,out)&&github.marker?.validationPassed===true));
 }
 return ok?{action:"close"}:{action:"preserve",reason:"github_persistence_not_confirmed"};
}
module.exports={evaluateCompletionPersistence};

'use strict';

const REPLACEMENTS=[
  [/\bplease be advised that\b/gi,''],
  [/\byou are required to\b/gi,'you must'],
  [/\bshall be required to\b/gi,'must'],
  [/\bis required to\b/gi,'must'],
  [/\bprior to\b/gi,'before'],
  [/\bsubsequent to\b/gi,'after'],
  [/\bwith regard to\b/gi,'about'],
  [/\bfurnish\b/gi,'provide'],
  [/\bdocumentation\b/gi,'documents'],
  [/\butili[sz]e\b/gi,'use'],
  [/\bcommence\b/gi,'start'],
  [/\bthereafter\b/gi,'after that']
];
const ACTIONS=/\b(?:submit|upload|send|provide|complete|sign|pay|attend|bring|reply|respond|contact|return|register|apply|collect|book|confirm|verify|attach|download|schedule|visit|email|call|present|notify|renew|update|review|check|accept|decline|report)\b/i;
const REQUIREMENTS=['identity document','id copy','passport','proof of address','proof of residence','bank statement','birth certificate','marriage certificate','academic record','transcript','certificate','reference letter','payslip','tax number','proof of payment','application form','supporting documents','photo','permit','licence','license','registration document','invoice','receipt'];

function cleanText(value) {
  return String(value||'').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function simplifySentence(sentence) {
  let value=cleanText(sentence);
  for(const [regex,replacement] of REPLACEMENTS) value=value.replace(regex,replacement);
  value=value.replace(/\s{2,}/g,' ').trim();
  return value?value[0].toUpperCase()+value.slice(1):'';
}
function splitSentences(text) {
  return cleanText(text).replace(/\n+/g,' ').split(/(?<=[.!?;:])\s+(?=[A-Z0-9])/).map(x=>x.trim()).filter(Boolean);
}
function extractDeadlines(text) {
  const dates=[];
  const rx=/(?:by|before|on|no later than|deadline:?|due:?|until)\s+(\d{1,2}\s+[a-z]{3,9}\s+\d{4}|[a-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/gi;
  let match;
  while((match=rx.exec(text))!==null) {
    const parsed=new Date(match[1]);
    if(Number.isNaN(parsed.getTime())||parsed.getFullYear()<2000||parsed.getFullYear()>2100) continue;
    dates.push({raw:match[1],iso:parsed.toISOString().slice(0,10)});
  }
  return [...new Map(dates.map(x=>[x.iso,x])).values()].sort((a,b)=>a.iso.localeCompare(b.iso)).slice(0,10);
}
function extractActions(text) {
  const seen=new Set(),output=[];
  for(const sentence of splitSentences(text)) {
    if(!ACTIONS.test(sentence)||!/\b(?:must|required|please|need to|should|by|before|within|you|your|applicant)\b/i.test(sentence)) continue;
    const label=simplifySentence(sentence).replace(/^you (?:must|should|need to|have to) /i,'').replace(/^please /i,'').replace(/^you /i,'');
    const key=label.toLowerCase().replace(/\W+/g,' ').slice(0,100);
    if(seen.has(key)) continue;
    seen.add(key);
    output.push(label.charAt(0).toUpperCase()+label.slice(1));
    if(output.length===10) break;
  }
  return output;
}
function extractRequirements(text) {
  const lower=text.toLowerCase(),found=[];
  for(const candidate of REQUIREMENTS) if(lower.includes(candidate)) found.push(candidate.replace(/\b\w/g,c=>c.toUpperCase()));
  for(const line of text.split('\n')) {
    if(/^\s*(?:[-•*]|\d+[.)])\s+/.test(line)&&/\b(?:document|copy|proof|certificate|form|passport|id)\b/i.test(line)) {
      found.push(line.replace(/^\s*(?:[-•*]|\d+[.)])\s+/,'').trim());
    }
  }
  return [...new Set(found)].slice(0,12);
}
function extractReferences(text) {
  const found=[];
  const rx=/(?:reference|ref|case|application|ticket|claim|student|invoice)\s*(?:number|no\.?|#|:)\s*([A-Z0-9-]{5,})/gi;
  let match;
  while((match=rx.exec(text))!==null) found.push(match[1]);
  return [...new Set(found)].slice(0,6);
}
function getUrgency(deadlines) {
  if(!deadlines.length)return {level:'steady',label:'No clear deadline found'};
  const today=new Date();today.setHours(0,0,0,0);
  const days=Math.ceil((new Date(deadlines[0].iso+'T00:00:00')-today)/86400000);
  if(days<0) return {level:'late',label:'A detected deadline has passed'};
  if(days<=3) return {level:'urgent',label:days+' day(s) to the next deadline'};
  if(days<=10) return {level:'soon',label:days+' days to the next deadline'};
  return {level:'steady',label:days+' days to the next deadline'};
}
function buildRoadmap(text,title='Untitled document') {
  const clean=cleanText(text);
  const actionLabels=extractActions(clean);
  const deadlines=extractDeadlines(clean);
  const requirements=extractRequirements(clean);
  const emails=[...new Set((clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(x=>x.toLowerCase()))];
  const phones=[...new Set((clean.match(/(?:\+?\d[\d\s().-]{7,}\d)/g)||[]).map(x=>x.trim()).filter(x=>x.replace(/\D/g,'').length>=9))].slice(0,8);
  const labels=actionLabels.length?actionLabels:['Read the summary and identify the next action'];
  const steps=labels.map((label,i)=>({
    id:'step-'+(i+1),
    label,
    category:/\bpay|payment|fee\b/i.test(label)?'payment':/\battend|visit|appointment\b/i.test(label)?'appointment':/\bsubmit|upload|send|provide|attach|return\b/i.test(label)?'submit':'action',
    done:false,
    help:'Focus on this one step. Verify the details against the original document and ask the issuing organisation if anything is unclear.'
  }));
  const summary=actionLabels.length?'This document asks you to '+actionLabels.slice(0,2).join(', then ').replace(/[.!?]+$/,'')+'.':splitSentences(clean).slice(0,2).map(simplifySentence).join(' ').slice(0,420);
  return {
    title:cleanText(title)||'Untitled document',
    summary,
    urgency:getUrgency(deadlines),
    deadlines,
    requirements,
    contacts:{emails,phones},
    references:extractReferences(clean),
    steps,
    stats:{wordCount:clean.split(/\s+/).filter(Boolean).length,actionCount:steps.length,requirementCount:requirements.length},
    sourcePreview:clean.slice(0,1000)
  };
}
module.exports={cleanText,simplifySentence,extractDeadlines,extractActions,extractRequirements,buildRoadmap};

export const balanceRetryDelay=failures=>Math.min(300000,10000*2**Math.min(5,Math.max(0,failures-1)));

const messages=Object.freeze({
 network:'网络不可用，暂时无法读取余额。',
 login:'余额来源未登录或授权已失效。',
 limited:'余额接口被限流，稍后自动重试。',
 'no-response':'Harness 暂未返回有效余额。',
});
export function balanceFailure(error){
 const text=String(error?.message??error??''),status=error?.status;
 const reason=status===429||/\b429\b|限流|rate limit/i.test(text)?'limited'
  :status==='not-configured'||[401,403].includes(status)||/\b(?:401|403)\b|未登录|未配置密钥|配置.*API Key|授权已失效|unauthorized/i.test(text)?'login'
  :/ENET|ENOTFOUND|EAI_AGAIN|fetch failed|网络不可用|network|offline|ECONNREFUSED/i.test([text,error?.code,error?.cause?.code].join(' '))?'network'
  :'no-response';
 return {reason,message:messages[reason]};
}

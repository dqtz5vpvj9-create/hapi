export const htmlReportPath = '\\\\?\\C:\\Users\\fixture\\report\\阅读台账.html'
const rows = Array.from({ length: 80 }, (_, index) => `<tr><td>联系人 ${index + 1}</td><td><details><summary>顺序阅读原文</summary><a href="file:///C:/Users/fixture/report/packets/%E5%8E%9F%E6%96%87%201.txt">原文 1</a></details></td></tr>`).join('\n')
export const htmlReport = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>阅读台账</title>
<link rel="stylesheet" href="styles/report.css"><script defer src="scripts/filter.js"></script></head><body>
<header><img src="images/mark.svg" width="32" height="32" alt="报告标记"><h1>全联系人深读 · 阅读台账</h1></header>
<label>查找联系人 <input id="filter" placeholder="输入联系人编号"></label><p id="quote">这是可选中并请求修改的报告正文。</p>
<a href="#end">跳到末尾</a> <a href="https://example.com/help">外部帮助</a>
<table><thead><tr><th>联系人</th><th>原文</th></tr></thead><tbody>${rows}</tbody></table><p id="end">阅读完毕</p>
<script>window.reportStarts=(window.reportStarts||0)+1;try{parent.localStorage.getItem('hapi_access_token');document.body.dataset.isolated='false'}catch{document.body.dataset.isolated='true'}</script>
</body></html>`
export const htmlIsolationReport = '<!doctype html><html><head><style>body{background-image:url(https://example.com/background.png)}</style></head><body><h1>隔离边界测试</h1><img src="https://example.com/image.png"><iframe src="https://example.com/frame"></iframe><script>fetch("https://example.com/private").then(()=>document.body.dataset.network="allowed").catch(()=>document.body.dataset.network="blocked");try{parent.localStorage.getItem("hapi_access_token");document.body.dataset.isolated="false"}catch{document.body.dataset.isolated="true"}</script></body></html>'
const files: Record<string, string> = {
    [htmlReportPath]: htmlReport,
    'C:\\Users\\fixture\\report\\styles\\report.css': '@import "common/base.css"; header{display:flex;align-items:center;gap:12px}h1{font-size:22px}body{margin:20px;color:#243042}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}input{border:1px solid #bbb;padding:8px;max-width:100%}',
    'C:\\Users\\fixture\\report\\styles\\common\\base.css': 'body{font-family:system-ui,sans-serif}a{color:#1567bb}summary{cursor:pointer}',
    'C:\\Users\\fixture\\report\\images\\mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#1567bb"/><path d="M9 16l5 5 10-11" fill="none" stroke="white" stroke-width="3"/></svg>',
    'C:\\Users\\fixture\\report\\scripts\\filter.js': `document.getElementById('filter').addEventListener('input',event=>{for(const row of document.querySelectorAll('tbody tr'))row.hidden=!row.textContent.includes(event.target.value)})`,
    'C:\\Users\\fixture\\report\\packets\\原文 1.txt': '原文文档已从 Lis-iMac 打开。\n这条链接应保留原会话和所属机器。',
}
export const htmlReportFiles = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.startsWith('\\\\?\\') ? path : `\\\\?\\${path}`, text]))

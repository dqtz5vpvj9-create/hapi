import subprocess,os,json,time,threading,queue,ctypes,ctypes.wintypes as w,pathlib,uuid
class ProcEntry(ctypes.Structure):
 _fields_=[('dwSize',w.DWORD),('cntUsage',w.DWORD),('th32ProcessID',w.DWORD),('th32DefaultHeapID',ctypes.c_size_t),('th32ModuleID',w.DWORD),('cntThreads',w.DWORD),('th32ParentProcessID',w.DWORD),('pcPriClassBase',w.LONG),('dwFlags',w.DWORD),('szExeFile',w.WCHAR*260)]
base=pathlib.Path(r'D:\hapi\temp\memory-restore-20261011')
base.mkdir(exist_ok=True)
trial=base/str(uuid.uuid4());trial.mkdir()
codex=r'C:\Users\lixinrui\AppData\Local\OpenAI\Codex\bin\9691020b546a15b2\codex.exe'
node=r'C:\nvm4w\nodejs\node.exe'
fixture=r'D:\hapi\temp\memory-mcp-fixture-20261011.mjs'
marker=trial/'mcp-events.jsonl'
config='''model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.mock]
name = "No model calls"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
[analytics]
enabled = false
[feedback]
enabled = false
'''
for name in ['fixture_a']:
 config+=f'\n[mcp_servers.{name}]\ncommand = {json.dumps(node)}\nargs = [{json.dumps(fixture)}, {json.dumps(str(marker))}]\n'
config+=f'\n[mcp_servers.hapi]\ncommand = {json.dumps(chr(68)+chr(58)+chr(92)+"hapi"+chr(92)+"bin"+chr(92)+"hapi-20261004.exe")}\nargs = ["mcp", "--url", "http://127.0.0.1:1/mcp", "--tools", "change_title"]\n'
(trial/'config.toml').write_text(config)
# Query only explicitly owned process handles. No WMI or production process mutation.
k=ctypes.WinDLL('kernel32',use_last_error=True);ps=ctypes.WinDLL('psapi',use_last_error=True)
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE]
k.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];k.CreateToolhelp32Snapshot.restype=w.HANDLE
k.Process32FirstW.argtypes=[w.HANDLE,ctypes.POINTER(ProcEntry)];k.Process32NextW.argtypes=[w.HANDLE,ctypes.POINTER(ProcEntry)]
def children(parent):
 h=k.CreateToolhelp32Snapshot(2,0);r=ProcEntry();r.dwSize=ctypes.sizeof(r);items=[]
 try:
  ok=k.Process32FirstW(h,ctypes.byref(r))
  while ok:
   if r.th32ParentProcessID==parent:items.append((r.th32ProcessID,r.szExeFile))
   ok=k.Process32NextW(h,ctypes.byref(r))
 finally:k.CloseHandle(h)
 return items
k.GetExitCodeProcess.argtypes=[w.HANDLE,ctypes.POINTER(w.DWORD)]
class Mem(ctypes.Structure):
 _fields_=[('cb',w.DWORD),('PageFaultCount',w.DWORD)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage']]
ps.GetProcessMemoryInfo.argtypes=[w.HANDLE,ctypes.POINTER(Mem),w.DWORD]
def mem(pid):
 h=k.OpenProcess(0x410,False,pid)
 if not h:return None
 try:
  code=w.DWORD()
  if not k.GetExitCodeProcess(h,ctypes.byref(code)) or code.value!=259:return None
  m=Mem();m.cb=ctypes.sizeof(m)
  if not ps.GetProcessMemoryInfo(h,ctypes.byref(m),m.cb):return None
  return {'pid':pid,'ws':m.WorkingSetSize,'privateBytes':m.PrivateUsage}
 finally:k.CloseHandle(h)
def events():
 if not marker.exists():return []
 return [json.loads(s) for s in marker.read_text().splitlines()]
server=None;results=[];notifications=[];out=queue.Queue();seq=0
try:
 env={**os.environ,'CODEX_HOME':str(trial),'TEMP':r'D:\hapi\temp','TMP':r'D:\hapi\temp'}
 server=subprocess.Popen([codex,'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(trial/'stderr.log','w'),text=True,encoding='utf-8',env=env,cwd=trial)
 def reader():
  for line in server.stdout:
   try:out.put(json.loads(line))
   except ValueError:pass
 threading.Thread(target=reader,daemon=True).start()
 def request(method,params):
  global seq
  seq+=1;current=seq;t=time.monotonic()
  server.stdin.write(json.dumps({'id':current,'method':method,'params':params})+'\n');server.stdin.flush()
  while True:
   r=out.get(timeout=20)
   if r.get('id')==current and 'method' not in r:
    if 'error' in r:raise RuntimeError(json.dumps(r['error']))
    return r['result'],round((time.monotonic()-t)*1000,2)
   if 'method' in r:notifications.append(r['method'])
 def snapshot(stage):
  time.sleep(1)
  ev=events();ids={v['pid'] for v in ev if v['method']=='process-start'}
  direct=[{**m,'name':name} for p,name in children(server.pid) if (m:=mem(p))]
  results.append({'directChildren':direct,'stage':stage,'utc':time.time(),'server':mem(server.pid),'fixtureProcesses':[m for p in ids if (m:=mem(p))],'events':ev})
 request('initialize',{'clientInfo':{'name':'hapi-memory-isolated-fixture','version':'1'},'capabilities':{'experimentalApi':True}})
 server.stdin.write('{"method":"initialized"}\n');server.stdin.flush()
 snapshot('initialized-no-thread')
 thread_id='01a12898-bd7b-7390-9afe-ac54317e60ad'
 saved=trial/'sessions'/'2026'/'10'/'11'/f'rollout-2026-10-11T09-00-00-{thread_id}.jsonl'
 saved.parent.mkdir(parents=True,exist_ok=True)
 stamp='2026-10-11T01:00:00.000Z'
 records=[
  {'timestamp':stamp,'type':'session_meta','payload':{'id':thread_id,'timestamp':stamp,'cwd':str(trial),'originator':'codex_cli_rs','cli_version':'0.162.0-alpha.2','source':'cli','model_provider':'mock'}},
  {'timestamp':stamp,'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'HAPI memory profiling synthetic saved history. No live model request.'}]}},
  {'timestamp':stamp,'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'Synthetic saved reply.'}],'phase':'final_answer'}}]
 saved.write_text(''.join(json.dumps(r)+'\n' for r in records))
 response,ms=request('thread/read',{'threadId':thread_id,'includeTurns':False});snapshot('read-cold-synthetic-history');results[-1]['requestMs']=ms
 response,ms=request('thread/resume',{'threadId':thread_id,'excludeTurns':True});snapshot('resume-exclude-turns');results[-1]['requestMs']=ms
 response,ms=request('thread/unsubscribe',{'threadId':thread_id});snapshot('final-unsubscribe');results[-1]['response']=response
 time.sleep(5);snapshot('six-seconds-after-unsubscribe')
except Exception as e:results.append({'error':str(e)})
finally:
 if server:
  server.stdin.close()
  try:server.wait(timeout=12)
  except subprocess.TimeoutExpired:server.terminate();server.wait(timeout=5)
 time.sleep(.5)
 ids={e['pid'] for e in events() if e['method']=='process-start'}
 remaining=[m for p in ids if (m:=mem(p))]
 result={'trial':str(trial),'results':results,'notifications':notifications,'cleanup':{'serverExited':server is None or server.poll() is not None,'remainingFixtureProcesses':remaining},'modelRequests':0}
 (trial/'result.json').write_text(json.dumps(result,indent=2))
 print(json.dumps(result))

#!/usr/bin/env python3
"""Install the native subagent feature into an existing HAPI runtime source snapshot.

Keeps the snapshot's other fixes and service configuration intact. Restart the
hub, runner and native bridge after running this command.
"""
from pathlib import Path
import argparse
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('runtime', type=Path, help='Existing runtime source snapshot')
args = parser.parse_args()
source = Path(__file__).resolve().parents[2]
target = args.runtime.resolve()

for name in [
    'hub/src/sync/codexLineageBackfill.ts',
    'cli/src/codex/utils/codexLineageLookup.ts',
    'cli/src/codex/utils/codexSubagentMetadata.ts',
    'cli/src/codex/utils/codexSubagentHistory.ts',
]:
    shutil.copy2(source / name, target / name)

def install_block(name, start, end, imports=()):
    current = (target / name).read_text()
    desired = (source / name).read_text()
    block = desired[desired.index(start):desired.index(end, desired.index(start))]
    begin = current.index(start)
    finish = current.index(end, begin)
    current = current[:begin] + block + current[finish:]
    for statement in imports:
        if statement not in current:
            current = statement + '\n' + current
    (target / name).write_text(current)

install_block('cli/src/api/apiMachine.ts',
    '        this.rpcHandlerManager.registerHandler(RPC_METHODS.CodexSessionLineage,',
    '        this.rpcHandlerManager.registerHandler<unknown, ListCodexSessionsRpcResponse>',
    ["import { ReadCodexSubagentMessagesRequestSchema } from '@hapi/protocol/apiTypes'",
     "import { readCodexSubagentMessages } from '../codex/utils/codexSubagentHistory'"])
# The read handler precedes the lineage handler in source. Insert it once.
name = 'cli/src/api/apiMachine.ts'
current = (target / name).read_text()
if 'registerHandler(RPC_METHODS.ReadCodexSubagentMessages,' not in current:
    desired = (source / name).read_text()
    start = '        this.rpcHandlerManager.registerHandler(RPC_METHODS.ReadCodexSubagentMessages,'
    end = '        this.rpcHandlerManager.registerHandler(RPC_METHODS.CodexSessionLineage,'
    block = desired[desired.index(start):desired.index(end)]
    (target / name).write_text(current.replace(end, block + end, 1))

install_block('hub/src/sync/syncEngine.ts',
    '    async refreshCodexSessionLineage(namespace:',
    '    async listCodexSessionsForMachine(')
name = 'hub/src/sync/rpcGateway.ts'
current = (target / name).read_text()
if '    async readCodexSubagentMessages(' not in current:
    desired = (source / name).read_text()
    start = '    async readCodexSubagentMessages('
    end = '    async readCodexHistory('
    block = desired[desired.index(start):desired.index(end)]
    current = current.replace(end, block + end, 1)
statement = "import { CodexSubagentMessagesResponseSchema } from '@hapi/protocol/apiTypes'"
if statement not in current:
    current = statement + '\n' + current
(target / name).write_text(current)

name = 'hub/src/web/routes/messages.ts'
current = (target / name).read_text()
if "app.get('/sessions/:id/codex-subagents/:threadId/messages'" not in current:
    desired = (source / name).read_text()
    start = "    app.get('/sessions/:id/codex-subagents/:threadId/messages'"
    end = "    app.get('/sessions/:id/messages/outline'"
    block = desired[desired.index(start):desired.index(end)]
    current = current.replace(end, block + end, 1)
statement = "import { CodexSubagentMessagesQuerySchema } from '@hapi/protocol/apiTypes'"
if statement not in current:
    current = statement + '\n' + current
(target / name).write_text(current)
print('Installed native subagent inventory and history in', target)

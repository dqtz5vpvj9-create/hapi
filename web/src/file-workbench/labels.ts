import { useTranslation } from '@/lib/use-translation'

const en = {
    tabs: 'Open files', showTree: 'Show file tree', hideTree: 'Hide file tree', showFile: 'Show file',
    empty: 'Open a file from the tree to preview or edit it.', close: 'Close',
    resize: 'Resize file tree',
    busy: 'Wait for the current file operation to finish.', expand: 'Expand file workspace', restore: 'Restore workspace size',
}
const zh: typeof en = {
    tabs: '已打开的文件', showTree: '显示文件树', hideTree: '收起文件树', showFile: '显示文件',
    empty: '从文件树打开文件，即可预览或编辑。', close: '关闭',
    resize: '调整文件树宽度',
    busy: '请等待当前文件操作完成。', expand: '展开文件工作区', restore: '还原工作区大小',
}
export function useFileWorkbenchLabels() { return useTranslation().locale.startsWith('zh') ? zh : en }

import { useTranslation } from '@/lib/use-translation'

const en = {
    tabs: 'Open files', showTree: 'Show file tree', showFile: 'Show file', reveal: 'Reveal in file tree',
    empty: 'Open a file from the tree to preview or edit it.', close: 'Close', closeOthers: 'Close other files',
    resize: 'Resize file tree', actions: 'File tab actions', previous: 'Previous file', next: 'Next file',
    busy: 'Wait for the current file operation to finish.', expand: 'Expand file workspace', restore: 'Restore workspace size',
}
const zh: typeof en = {
    tabs: '已打开的文件', showTree: '显示文件树', showFile: '显示文件', reveal: '在文件树中定位',
    empty: '从文件树打开文件，即可预览或编辑。', close: '关闭', closeOthers: '关闭其他文件',
    resize: '调整文件树宽度', actions: '文件标签操作', previous: '上一个文件', next: '下一个文件',
    busy: '请等待当前文件操作完成。', expand: '展开文件工作区', restore: '还原工作区大小',
}
export function useFileWorkbenchLabels() { return useTranslation().locale.startsWith('zh') ? zh : en }

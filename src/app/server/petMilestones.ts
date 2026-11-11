/**
 * 桌宠阶段摘要。
 *
 * 只根据真实工具结果生成，不调用模型、不编造进度。
 * 工具名和参数留在完整对话里，桌宠只显示一句人话。
 */

export function milestoneForTool(args: {
  readonly name: string;
  readonly ok: boolean;
  readonly denied: boolean;
}): string | null {
  if (args.denied) return '这一步需要你确认，我先停一下。';
  const { name, ok } = args;
  if (name === 'plan_task') return ok ? '我先理一下怎么做。' : '这次没有理清任务，我换个方式。';
  if (!ok) {
    switch (name) {
      case 'read_file':
        return '这个文件没读出来，我换个方式。';
      case 'list_dir':
        return '这里没找到，我换个地方看看。';
      case 'stat_path':
        return '这个路径不对，我再确认一下。';
      case 'write_file':
      case 'apply_patch':
        return '这一步没写成功，我检查一下原因。';
      case 'document_search':
        return '文档里没找到相关内容，我换个方式。';
      default:
        return null;
    }
  }

  switch (name) {
    case 'read_file':
      return '文件读到了，我继续看。';
    case 'list_dir':
      return '目录看到了，我继续找。';
    case 'stat_path':
      return '路径确认了，我继续。';
    case 'write_file':
    case 'apply_patch':
      return '已经改好了，我检查一下结果。';
    case 'make_dir':
      return '目录建好了，我继续。';
    case 'move_path':
      return '已经挪好了，我继续。';
    case 'remove_path':
      return '已经清理掉了，我继续。';
    case 'document_search':
      return '找到相关文档了，我看一下。';
    default:
      return null;
  }
}

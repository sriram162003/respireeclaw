/**
 * PDF Editor Skill Executor
 * Handles PDF operations using browser automation and filesystem access
 */

interface BrowserArgs {
  action: string;
  url?: string;
  selector?: string;
  value?: string;
  wait_for?: string;
}

interface FilesystemArgs {
  action: string;
  path: string;
  content?: string;
  encoding?: string;
}

interface WebSearchArgs {
  query: string;
  num_results?: string;
}

// Tool call registry - these will be provided by the runtime
declare const callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;

export async function browser(args: BrowserArgs, _ctx: unknown): Promise<unknown> {
  const { action, url, selector, value, wait_for } = args;

  switch (action.toLowerCase()) {
    case 'open': {
      if (!url) throw new Error('URL is required for browser open action');
      return await callTool('browser_open', { url, wait_for: wait_for || 'networkidle' });
    }

    case 'click': {
      if (!selector) throw new Error('Selector is required for browser click action');
      return await callTool('browser_click', { selector, wait_for });
    }

    case 'type': {
      if (!selector) throw new Error('Selector is required for browser type action');
      if (value === undefined) throw new Error('Value is required for browser type action');
      return await callTool('browser_type', { selector, text: value, wait_for });
    }

    case 'read': {
      return await callTool('browser_read', { selector: selector || 'body' });
    }

    case 'upload': {
      if (!selector) throw new Error('Selector is required for browser upload action');
      if (!value) throw new Error('File path is required for browser upload action');
      return await callTool('browser_upload', { selector, file_path: value });
    }

    case 'download': {
      return await callTool('browser_download', {
        selector: selector || 'a[download], button[download]',
        save_path: value,
      });
    }

    case 'screenshot': {
      return await callTool('browser_screenshot', { path: value || 'screenshot.png' });
    }

    case 'wait': {
      if (!wait_for) throw new Error('wait_for is required for browser wait action');
      return await callTool('browser_wait', { condition: wait_for, timeout: value || '10000' });
    }

    default:
      throw new Error(`Unknown browser action: ${action}`);
  }
}

export async function pdf_read_write(args: FilesystemArgs, _ctx: unknown): Promise<unknown> {
  const { action, path, content, encoding = 'utf8' } = args;

  switch (action.toLowerCase()) {
    case 'read': {
      return await callTool('read_file', { path, encoding });
    }

    case 'write': {
      if (content === undefined) throw new Error('Content is required for filesystem write action');
      return await callTool('write_file', { path, content, encoding });
    }

    case 'list': {
      return await callTool('list_directory', { path });
    }

    case 'delete': {
      return await callTool('delete_file', { path });
    }

    case 'copy': {
      if (!content) throw new Error('Destination path is required for filesystem copy action');
      return await callTool('copy_file', { source: path, destination: content });
    }

    case 'move': {
      if (!content) throw new Error('Destination path is required for filesystem move action');
      return await callTool('move_file', { source: path, destination: content });
    }

    case 'exists': {
      return await callTool('file_exists', { path });
    }

    case 'info': {
      return await callTool('file_info', { path });
    }

    default:
      throw new Error(`Unknown filesystem action: ${action}`);
  }
}

export async function pdf_search(args: WebSearchArgs, _ctx: unknown): Promise<unknown> {
  const { query, num_results = '5' } = args;

  if (!query) throw new Error('Query is required for web search');

  return await callTool('web_search', {
    query: `${query} PDF tool API`,
    num_results: parseInt(num_results, 10) || 5,
  });
}

import type { EvidenceItem } from '@eight/shared';

/**
 * 工具注册表：证据获取阶段按场景包声明的工具名取工具、按槽位组装参数执行。
 * 工具的实现由宿主（API 层）注入，agent-core 只定义契约与执行/审计包装。
 */
export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  /** 需要的槽位键；缺失时不调用（避免无键遍历） */
  requires: string[];
  /** 是否是会改变业务状态的动作工具（动作工具不在证据阶段执行） */
  mutating?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  conversationId: string;
  customerId?: string | null;
  traceId: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition) {
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()].map(({ run, ...d }) => d);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext, seq: number): Promise<EvidenceItem> {
    const def = this.tools.get(name);
    const started = Date.now();
    if (!def) {
      return { id: `tool:${name}#${seq}`, tool: name, label: name, ok: false, durationMs: 0, args, data: null, error: '工具未注册' };
    }
    try {
      const data = await def.run(args, ctx);
      return { id: `tool:${name}#${seq}`, tool: name, label: def.label, ok: true, durationMs: Date.now() - started, args, data };
    } catch (e) {
      return { id: `tool:${name}#${seq}`, tool: name, label: def.label, ok: false, durationMs: Date.now() - started, args, data: null, error: (e as Error).message };
    }
  }
}

// Spark MCP: the conversation loop, from SDK Controller. The model asks for tools, reads run straight away, edits
// wait for the user, and the results go back until the model is done. No DOM and no LUNA: tools and
// the approval step are passed in, so tests drive it with a scripted provider.

// Classic scripts share one global scope, so each file keeps its names to itself.
(() => {
const MAX_TURNS = 40;
const MAX_RESULT_CHARS = 40000;

/** Enough JSON Schema for this catalog: type, enum, required, properties, items, min and max. */
function checkSchema(schema, value, path = 'input') {
  if (schema.anyOf) {
    return schema.anyOf.some((s) => checkSchema(s, value, path).length === 0) ? [] : [`${path}: no allowed form matches`];
  }
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(', ')}`];
  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: must be an object`];
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...checkSchema(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not a known field`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: must be an array`];
    value.forEach((v, i) => errors.push(...checkSchema(schema.items ?? {}, v, `${path}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: must be a string`];
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return [`${path}: must be true or false`];
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: must be a number`];
    if (t === 'integer' && !Number.isInteger(value)) return [`${path}: must be a whole number`];
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be at most ${schema.maximum}`);
  }
  return errors;
}

function resultText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true });
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut at ${MAX_RESULT_CHARS} characters of ${text.length}. Ask for something narrower.]`;
}

class Agent {
  /**
   * @param {object} o
   * @param {() => {stream: Function, apiKey?: string, baseUrl?: string, model: string}} o.provider
   *   read before every request, so a settings change applies from the next one.
   * @param {() => string} o.system
   * @param {{name, description, schema, mode, describe, batch?}[]} o.tools mode: read | edit | always-ask
   * @param {(calls: object[]) => Promise<object[]>} o.execute runs the approved calls in order and
   *   answers `{ content, isError }` for each.
   * @param {(calls: object[]) => Promise<boolean[]>} o.approve one yes or no per call.
   */
  constructor({ provider, system, tools, execute, approve }) {
    Object.assign(this, { provider, system, tools, execute, approve });
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.messages = [];
    this.controller = null;
  }

  get running() {
    return this.controller !== null;
  }

  stop() {
    this.controller?.abort();
  }

  reset() {
    this.stop();
    this.messages = [];
  }

  /** Run one user request to its end. Hooks: onText(delta), onTurnStart(), onCalls(entries), onResult(entry). */
  async send(text, hooks = {}) {
    if (this.running) throw new Error('Already working on a request.');
    const controller = new AbortController();
    this.controller = controller;
    this.messages.push({ role: 'user', text });
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        hooks.onTurnStart?.();
        const p = this.provider();
        const reply = await p.stream({
          apiKey: p.apiKey,
          baseUrl: p.baseUrl,
          model: p.model,
          system: this.system(),
          messages: this.messages,
          tools: this.tools,
          signal: controller.signal,
          onText: hooks.onText,
        });

        if (reply.stopReason === 'refusal') {
          // Nothing from a declined turn is kept or run. A partial tool call can be cut off in it.
          if (this.messages.at(-1)?.role === 'user') this.messages.pop();
          return { outcome: 'refused', text: reply.text };
        }

        this.messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, native: reply.native });
        if (!reply.toolCalls.length) {
          if (reply.stopReason === 'max_tokens') return { outcome: 'cut-off', text: reply.text };
          return { outcome: 'done', text: reply.text };
        }

        const results = await this.runCalls(reply, hooks, controller.signal);
        this.messages.push({ role: 'tool', results });
        if (controller.signal.aborted) return { outcome: 'stopped' };
      }
      return { outcome: 'turn-limit' };
    } catch (e) {
      if (e?.name === 'AbortError') {
        this.closeOpenCalls('Stopped by the user before this ran.');
        return { outcome: 'stopped' };
      }
      this.closeOpenCalls('The request failed before this ran.');
      throw e;
    } finally {
      this.controller = null;
    }
  }

  /** A tool call with no result would fail every later request, so answer any that are open. */
  closeOpenCalls(reason) {
    const last = this.messages.at(-1);
    if (last?.role !== 'assistant' || !last.toolCalls?.length) return;
    this.messages.push({ role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, name: c.name, content: reason, isError: true })) });
  }

  async runCalls(reply, hooks, signal) {
    const truncated = reply.stopReason === 'max_tokens';
    const entries = reply.toolCalls.map((call) => {
      const tool = this.byName.get(call.name);
      let error = null;
      if (truncated) error = 'The reply was cut off at the token limit, so this call may be incomplete. Send it again in smaller pieces.';
      else if (call.parseError) error = call.parseError;
      else if (!tool) error = `There is no tool named ${call.name}.`;
      else {
        const problems = checkSchema(tool.schema, call.input);
        if (problems.length) error = `INVALID_INPUT: ${problems.join('; ')}`;
      }
      return { call, tool, error, result: null, summary: tool && !error ? tool.describe(call.input) : call.name };
    });
    hooks.onCalls?.(entries);

    const done = (entry, content, isError) => {
      entry.result = { id: entry.call.id, name: entry.call.name, content: resultText(content), isError };
      hooks.onResult?.(entry);
    };
    for (const e of entries) if (e.error) done(e, e.error, true);

    // Order is kept: a read after an edit in the same turn sees that edit.
    const valid = entries.filter((e) => !e.error);
    const needsApproval = valid.filter((e) => e.tool.mode !== 'read');
    const decisions = new Map();
    if (needsApproval.length) {
      const answers = await this.approve(needsApproval.map((e) => ({ name: e.call.name, input: e.call.input, summary: e.summary, mode: e.tool.mode })), signal);
      needsApproval.forEach((e, i) => decisions.set(e, answers[i] === true));
    }
    const approved = [];
    for (const e of valid) {
      if (signal.aborted) done(e, 'Stopped by the user before this ran.', true);
      else if (decisions.get(e) === false) done(e, 'The user declined this step. Do not retry it unless they ask.', true);
      else approved.push(e);
    }
    if (approved.length) {
      const outcomes = await this.execute(approved.map((e) => ({ tool: e.tool, input: e.call.input })));
      approved.forEach((e, i) => done(e, outcomes[i].content, outcomes[i].isError === true));
    }
    return entries.map((e) => e.result);
  }
}

globalThis.AgentCore = { Agent, checkSchema, MAX_TURNS };
})();

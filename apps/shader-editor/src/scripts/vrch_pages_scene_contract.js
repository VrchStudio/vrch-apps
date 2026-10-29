/* VRCH Scene Contract v1: browser/Node canonicalization, validation and ABI wrapper. */
(function(root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const spec = isNode ? require('./vrch_pages_scene_spec.js') : (root && root.VrchSceneSpec);
  const api = factory(spec);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VrchSceneContract = api;
})(typeof window !== 'undefined' ? window : globalThis, function(Spec) {
  'use strict';

  if (!Spec || Spec.spec_version !== 1 || !Spec.documents) throw new Error('VrchSceneSpec v1 is required.');
  const ABI_SPEC = Spec.documents['abi.json'];
  const PROTOCOL_CONFIG = Spec.documents['protocol-config.json'];
  const RESOURCE_BUDGETS = Spec.documents['resource-budgets.json'];
  if (!ABI_SPEC || !PROTOCOL_CONFIG || !RESOURCE_BUDGETS) throw new Error('VrchSceneSpec is missing ABI, protocol config, or resource budgets.');
  const LIMITS = ABI_SPEC.limits;
  const PROTOCOL_TIMEOUTS = PROTOCOL_CONFIG.timeouts_ms;

  const CONFIG = Object.freeze({
    protocol: PROTOCOL_CONFIG.protocol,
    protocolVersion: PROTOCOL_CONFIG.protocol_version,
    abi: ABI_SPEC.id,
    abiVersion: ABI_SPEC.version,
    envelopeBytes: LIMITS.envelope_utf8_bytes,
    definitionBytes: LIMITS.definition_canonical_utf8_bytes,
    fragmentBytes: LIMITS.fragment_utf8_bytes,
    aiFragmentBytes: LIMITS.ai_fragment_utf8_bytes,
    instanceBytes: LIMITS.instance_canonical_utf8_bytes,
    maxParameters: LIMITS.parameters,
    maxSignals: LIMITS.ai_scalar_signals + LIMITS.ai_trigger_signals + LIMITS.ai_texture_signals,
    maxStaticLoopIterations: LIMITS.ai_static_loop_iterations,
    maxTextureSamples: LIMITS.ai_texture_samples_per_pixel,
    messageCacheEntries: PROTOCOL_CONFIG.idempotency.max_entries,
    messageCacheTtlMs: PROTOCOL_CONFIG.idempotency.ttl_ms,
    leaseTtlMs: PROTOCOL_CONFIG.lease.ttl_ms,
    disconnectGraceMs: PROTOCOL_CONFIG.lease.disconnect_grace_ms,
    mainPreviewTtlMs: PROTOCOL_CONFIG.main_preview.ttl_ms,
    protocolTimeouts: Object.freeze({
      'scene.prepare': PROTOCOL_TIMEOUTS.prepare,
      'runtime.activate': PROTOCOL_TIMEOUTS.activate,
      'scene.commit': PROTOCOL_TIMEOUTS.commit,
      'scene.preview_main.request': PROTOCOL_TIMEOUTS.main_preview,
      'transaction.handoff.request': PROTOCOL_TIMEOUTS.handoff_response,
      'transaction.handoff.transport': PROTOCOL_TIMEOUTS.handoff_transport,
      'instance.patch': PROTOCOL_TIMEOUTS.instance_patch,
      'scene.abort': PROTOCOL_TIMEOUTS.abort,
      default: PROTOCOL_TIMEOUTS.query
    }),
    protocolCalibrationStatus: PROTOCOL_CONFIG.calibration_status,
    stagingBudgetMs: RESOURCE_BUDGETS.staging.compile_link_first_frame_max_ms,
    stagingSizePx: RESOURCE_BUDGETS.staging.offscreen_size_px,
    performanceWindowFrames: RESOURCE_BUDGETS.performance_window.frames,
    performanceOverrunWindows: RESOURCE_BUDGETS.performance_window.overrun_windows_before_degrade,
    performanceRecoveryWindows: RESOURCE_BUDGETS.performance_window.healthy_windows_before_recover,
    performanceScaleLadder: Object.freeze(RESOURCE_BUDGETS.performance_window.render_scale_ladder.slice()),
    edgeFrameTimeP95Ms: RESOURCE_BUDGETS.edge_profile.frame_time_p95_max_ms,
    edgeMinimumFps: RESOURCE_BUDGETS.edge_profile.minimum_fps,
    frameTexels: ABI_SPEC.frame_stage.max_texels,
    frameBytes: ABI_SPEC.frame_stage.source_utf8_bytes,
    coarseDivisors: Object.freeze(ABI_SPEC.coarse_stage.divisors.slice()),
    coarseBytes: ABI_SPEC.coarse_stage.source_utf8_bytes,
    edgeFramePacing: RESOURCE_BUDGETS.edge_profile.frame_pacing,
    edgeOnePercentLowFps: RESOURCE_BUDGETS.edge_profile.one_percent_low_min_fps,
    edgePerSceneDurationMs: RESOURCE_BUDGETS.edge_profile.per_scene_duration_ms,
    edgeReferencePixels: RESOURCE_BUDGETS.edge_profile.preferred_scale_reference_pixels,
    switchCycles: RESOURCE_BUDGETS.switch_soak.cycles,
    switchScenes: RESOURCE_BUDGETS.switch_soak.scenes,
    switchSuccessfulFrames: RESOURCE_BUDGETS.switch_soak.successful_frames_per_cycle,
    switchWarmupCycles: RESOURCE_BUDGETS.switch_soak.warmup_cycles,
    switchTailCycles: RESOURCE_BUDGETS.switch_soak.tail_cycles,
    switchMaxTailGrowth: Object.freeze(Object.assign({}, RESOURCE_BUDGETS.switch_soak.max_tail_growth)),
    historyLimit: PROTOCOL_CONFIG.history.page_size_max
  });

  const PARAMETER_TYPES = Object.freeze({
    float: 'float', int: 'int', bool: 'bool', color: 'vec4', vec2: 'vec2', enum: 'int'
  });
  const SCENE_ID_RE = /^(vrch|user|legacy)\.[a-z0-9][a-z0-9.-]*$/;
  const PARAMETER_KEY_RE = /^[a-z][a-z0-9_]*$/;
  const SIGNAL_ID_RE = /^[a-z][a-z0-9_.-]*$/;
  const HASH_RE = /^sha256:[0-9a-f]{64}$/;
  const VIEWER_SENDER_TYPES = new Set(['image-viewer-v2']);
  const CONTROLLER_SENDER_TYPES = new Set(['shader-editor-v2', 'image-settings-v2']);
  const GLSL_BUILTIN_ARITIES = Object.freeze({
    abs: [1], ceil: [1], cos: [1], dFdx: [1], dFdy: [1], exp: [1], exp2: [1], floor: [1], fract: [1], fwidth: [1],
    inversesqrt: [1], length: [1], log: [1], log2: [1], normalize: [1], sign: [1], sin: [1], sqrt: [1], tan: [1],
    cross: [2], distance: [2], dot: [2], max: [2], min: [2], mod: [2], pow: [2], reflect: [2], step: [2],
    clamp: [3], faceforward: [3], mix: [3], refract: [3], smoothstep: [3]
  });
  const CLIENT_TO_VIEWER_TYPES = new Set([
    'hello', 'capabilities.request', 'runtime.activate', 'scene.prepare', 'draft.patch', 'scene.commit',
    'scene.abort', 'instance.patch', 'transaction.query', 'transaction.handoff.request',
    'transaction.handoff.grant', 'transaction.handoff.deny', 'transaction.takeover.request',
    'scene.preview_main.request', 'history.query', 'revision.fetch', 'definition.fetch', 'export.snapshot.request'
  ]);
  const VIEWER_TO_CLIENT_TYPES = new Set([
    'capabilities.result', 'runtime.activate.result', 'scene.ready', 'scene.rejected', 'draft.updated',
    'scene.committed', 'scene.aborted', 'instance.ack', 'instance.rejected', 'transaction.result',
    'transaction.handoff.requested', 'transaction.handoff.result', 'transaction.takeover.result',
    'scene.preview_main.result', 'history.result', 'revision.result', 'definition.result',
    'export.snapshot.result', 'state.snapshot', 'state.changed'
  ]);

  class ContractError extends Error {
    constructor(code, stage, message, details) {
      super(message);
      this.name = 'VrchSceneContractError';
      this.code = code;
      this.stage = stage;
      this.details = Array.isArray(details) ? details : [];
    }
    toJSON() {
      return { code: this.code, stage: this.stage, message: this.message, details: this.details };
    }
  }

  function canonicalize(value) {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new ContractError('schema_invalid', 'canonicalize', 'Only finite JSON numbers are supported.');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function(key) {
        return JSON.stringify(key) + ':' + canonicalize(value[key]);
      }).join(',') + '}';
    }
    throw new ContractError('schema_invalid', 'canonicalize', 'Unsupported JSON value: ' + typeof value);
  }

  function utf8Size(value) {
    const text = typeof value === 'string' ? value : canonicalize(value);
    return new TextEncoder().encode(text).byteLength;
  }

  async function sha256Ref(value) {
    const bytes = new TextEncoder().encode(canonicalize(value));
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return 'sha256:' + Array.from(new Uint8Array(digest)).map(function(byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    }
    if (typeof require === 'function') {
      return 'sha256:' + require('crypto').createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
    throw new ContractError('runtime_unavailable', 'canonicalize', 'SHA-256 is unavailable.');
  }

  function tokenizeGlsl(source) {
    const tokens = [];
    let index = 0;
    let line = 1;
    let column = 1;
    const multi = ['++', '--', '+=', '-=', '*=', '/=', '<=', '>=', '==', '!=', '&&', '||'];
    function advance(text) {
      const lines = text.split('\n');
      if (lines.length > 1) {
        line += lines.length - 1;
        column = lines[lines.length - 1].length + 1;
      } else column += text.length;
    }
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) { advance(char); index += 1; continue; }
      if (source.startsWith('//', index)) {
        let end = source.indexOf('\n', index);
        if (end < 0) end = source.length;
        advance(source.slice(index, end)); index = end; continue;
      }
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        if (end < 0) throw new ContractError('policy_rejected', 'static_policy', 'Unterminated comment at ' + line + ':' + column + '.');
        const text = source.slice(index, end + 2);
        advance(text); index = end + 2; continue;
      }
      const startLine = line;
      const startColumn = column;
      if (char === '#') throw new ContractError('policy_rejected', 'static_policy', 'Preprocessor directives are wrapper-owned.');
      const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (identifier) {
        tokens.push({ value: identifier[0], kind: 'identifier', line: startLine, column: startColumn });
        advance(identifier[0]); index += identifier[0].length; continue;
      }
      const number = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (number) {
        tokens.push({ value: number[0], kind: 'number', line: startLine, column: startColumn });
        advance(number[0]); index += number[0].length; continue;
      }
      const operator = multi.find(function(item) { return source.startsWith(item, index); });
      const value = operator || char;
      if (!'{}()[];,.?:+-*/%=<>!&|'.includes(value) && !multi.includes(value)) {
        throw new ContractError('policy_rejected', 'static_policy', 'Unsupported token at ' + line + ':' + column + '.');
      }
      tokens.push({ value: value, kind: 'symbol', line: startLine, column: startColumn });
      advance(value); index += value.length;
    }
    return tokens;
  }

  function matching(tokens, start, opening, closing) {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index].value === opening) depth += 1;
      if (tokens[index].value === closing) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    throw new ContractError('policy_rejected', 'static_policy', 'Unclosed ' + opening + '.');
  }

  function functionRanges(tokens) {
    const functions = new Map();
    const controls = new Set(['if', 'for', 'while', 'switch']);
    for (let index = 1; index + 2 < tokens.length; index += 1) {
      if (tokens[index].kind !== 'identifier' || controls.has(tokens[index].value) || tokens[index + 1].value !== '(') continue;
      const close = matching(tokens, index + 1, '(', ')');
      if (!tokens[close + 1] || tokens[close + 1].value !== '{') continue;
      const name = tokens[index].value;
      if (functions.has(name)) throw new ContractError('policy_rejected', 'static_policy', 'Duplicate function ' + name + '.');
      const bodyEnd = matching(tokens, close + 1, '{', '}');
      functions.set(name, { bodyStart: close + 2, bodyEnd: bodyEnd });
      index = bodyEnd;
    }
    return functions;
  }

  function validateStaticLoop(tokens, start) {
    if (!tokens[start + 1] || tokens[start + 1].value !== '(') throw new ContractError('policy_rejected', 'static_policy', 'Malformed for loop.');
    const close = matching(tokens, start + 1, '(', ')');
    const parts = [[]];
    let depth = 0;
    tokens.slice(start + 2, close).forEach(function(token) {
      if (token.value === '(' || token.value === '[') depth += 1;
      if (token.value === ')' || token.value === ']') depth -= 1;
      if (token.value === ';' && depth === 0) parts.push([]);
      else parts[parts.length - 1].push(token.value);
    });
    const init = parts[0] || [];
    const condition = parts[1] || [];
    const increment = parts[2] || [];
    if (parts.length !== 3 || init.length !== 4 || !['int', 'uint'].includes(init[0]) || init[2] !== '=' || !/^\d+$/.test(init[3])) {
      throw new ContractError('policy_rejected', 'static_policy', 'For initializer must use `for (int i = 0; i < LITERAL; i++)`; cast with `float fi = float(i)` inside.');
    }
    const variable = init[1];
    if (condition.length !== 3 || condition[0] !== variable || !['<', '<='].includes(condition[1]) || !/^\d+$/.test(condition[2])) {
      throw new ContractError('policy_rejected', 'static_policy', 'For bound must be a constant integer.');
    }
    const incrementOk = canonicalize(increment) === canonicalize([variable, '++']) ||
      canonicalize(increment) === canonicalize(['++', variable]) ||
      canonicalize(increment) === canonicalize([variable, '+=', '1']);
    if (!incrementOk) throw new ContractError('policy_rejected', 'static_policy', 'For increment must advance by one.');
    const iterations = Math.max(0, Number(condition[2]) - Number(init[3]) + (condition[1] === '<=' ? 1 : 0));
    if (iterations > CONFIG.maxStaticLoopIterations) throw new ContractError('budget_exceeded', 'static_policy', 'Static loop exceeds iteration budget.');
  }

  function callArguments(tokens, openIndex) {
    const close = matching(tokens, openIndex, '(', ')');
    if (close === openIndex + 1) return [];
    const argumentsList = [[]];
    let roundDepth = 0;
    let squareDepth = 0;
    tokens.slice(openIndex + 1, close).forEach(function(token) {
      if (token.value === '(') roundDepth += 1;
      else if (token.value === ')') roundDepth -= 1;
      else if (token.value === '[') squareDepth += 1;
      else if (token.value === ']') squareDepth -= 1;
      else if (token.value === ',' && roundDepth === 0 && squareDepth === 0) {
        argumentsList.push([]);
        return;
      }
      argumentsList[argumentsList.length - 1].push(token);
    });
    return argumentsList;
  }

  function callArgumentCount(tokens, openIndex) {
    return callArguments(tokens, openIndex).length;
  }

  function validateBuiltinArities(tokens) {
    tokens.slice(0, -1).forEach(function(token, index) {
      const expected = GLSL_BUILTIN_ARITIES[token.value];
      if (!expected || tokens[index + 1].value !== '(') return;
      const actual = callArgumentCount(tokens, index + 1);
      if (!expected.includes(actual)) {
        throw new ContractError('policy_rejected', 'static_policy', 'GLSL builtin ' + token.value + ' expects ' + expected.join('/') + ' argument(s), got ' + actual + ' at ' + token.line + ':' + token.column + '.');
      }
    });
  }

  function obviousGlslExpressionType(expression, identifierTypes) {
    const valueTypes = new Set(['float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4']);
    if (expression.length >= 2 && valueTypes.has(expression[0].value) && expression[1].value === '(') return expression[0].value;
    for (let index = 0; index + 1 < expression.length; index += 1) {
      if (expression[index].value !== '.') continue;
      const member = expression[index + 1].value;
      if (member && /^[xyzwrgba]{1,4}$/.test(member)) return member.length === 1 ? 'float' : 'vec' + member.length;
    }
    const candidates = new Set();
    expression.forEach(function(token) {
      const known = identifierTypes.get(token.value);
      if (known && known.size === 1) known.forEach(function(kind) { candidates.add(kind); });
    });
    if (candidates.size === 1) return Array.from(candidates)[0];
    if (expression.length && expression.every(function(token) {
      return token.kind === 'number' || ['+', '-', '*', '/', '(', ')'].includes(token.value);
    })) return 'float';
    return null;
  }

  function validateBuiltinArgumentTypes(tokens) {
    const valueTypes = new Set(['float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4']);
    const identifierTypes = new Map();
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      if (!valueTypes.has(tokens[index].value) || tokens[index + 1].kind !== 'identifier') continue;
      if (!identifierTypes.has(tokens[index + 1].value)) identifierTypes.set(tokens[index + 1].value, new Set());
      identifierTypes.get(tokens[index + 1].value).add(tokens[index].value);
    }
    tokens.slice(0, -1).forEach(function(token, index) {
      if (token.value !== 'cross' || tokens[index + 1].value !== '(') return;
      const types = callArguments(tokens, index + 1).map(function(argument) {
        return obviousGlslExpressionType(argument, identifierTypes);
      });
      const invalid = types.find(function(kind) { return kind !== null && kind !== 'vec3'; });
      if (invalid) {
        throw new ContractError('policy_rejected', 'static_policy', 'GLSL cross accepts vec3 operands, not ' + invalid + ', at ' + token.line + ':' + token.column + '; use a.x*b.y-a.y*b.x for a 2D determinant.');
      }
    });
  }

  function validateScalarFunctionSwizzles(tokens) {
    const scalarFunctions = new Set();
    for (let index = 1; index + 2 < tokens.length; index += 1) {
      if (!['float', 'int', 'uint', 'bool'].includes(tokens[index - 1].value)) continue;
      if (tokens[index].kind !== 'identifier' || tokens[index + 1].value !== '(') continue;
      const close = matching(tokens, index + 1, '(', ')');
      if (tokens[close + 1] && tokens[close + 1].value === '{') scalarFunctions.add(tokens[index].value);
    }
    tokens.slice(0, -1).forEach(function(token, index) {
      if (!scalarFunctions.has(token.value) || tokens[index + 1].value !== '(') return;
      const close = matching(tokens, index + 1, '(', ')');
      if (tokens[close + 1] && tokens[close + 1].value === '.') {
        const member = tokens[close + 2] ? tokens[close + 2].value : '';
        throw new ContractError('policy_rejected', 'static_policy', 'Scalar function ' + token.value + ' result cannot use .' + member + ' at ' + token.line + ':' + token.column + '.');
      }
    });
  }

  function validateSignalReads(tokens, definition) {
    const checks = [
      {
        helper: ABI_SPEC.scalar_signal_helper,
        count: definition.signals.filter(function(signal) { return signal.type !== 'texture'; }).length,
        argumentCount: 1,
        label: 'declared scalar/trigger signals'
      },
      {
        helper: ABI_SPEC.signal_texture_helper,
        count: definition.signals.filter(function(signal) { return signal.type === 'texture'; }).length,
        argumentCount: 2,
        label: 'declared texture signals'
      }
    ];
    checks.forEach(function(check) {
      tokens.forEach(function(token, index) {
        if (token.value !== check.helper || !tokens[index + 1] || tokens[index + 1].value !== '(') return;
        const close = matching(tokens, index + 1, '(', ')');
        const args = callArguments(tokens, index + 1);
        if (args.length !== check.argumentCount || args[0].length !== 1 || args[0][0].kind !== 'number' || !/^\d+$/.test(args[0][0].value)) {
          throw new ContractError('policy_rejected', 'static_policy', check.helper + ' requires a zero-based integer literal as its first argument at ' + token.line + ':' + token.column + '.');
        }
        const signalIndex = Number(args[0][0].value);
        if (signalIndex >= check.count) {
          throw new ContractError('policy_rejected', 'static_policy', check.helper + ' index ' + signalIndex + ' is out of range for ' + check.count + ' ' + check.label + '.');
        }
      });
    });
  }

  function validateFragmentPolicy(definition, options = {}) {
    const source = definition.fragment.source;
    const limit = options.trusted === true ? CONFIG.fragmentBytes : CONFIG.aiFragmentBytes;
    if (utf8Size(source) > limit) throw new ContractError('message_too_large', 'static_policy', 'Fragment exceeds its UTF-8 byte budget.');
    const tokens = tokenizeGlsl(source);
    const values = tokens.map(function(token) { return token.value; });
    const forbidden = new Set(['uniform', 'layout', 'precision', 'discard', 'gl_FragDepth', 'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube', 'while', 'do']);
    const found = Array.from(forbidden).filter(function(value) { return values.includes(value); });
    if (found.length) throw new ContractError('policy_rejected', 'static_policy', 'Forbidden GLSL tokens: ' + found.join(', ') + '.');
    const functions = functionRanges(tokens);
    if (functions.has('main')) throw new ContractError('policy_rejected', 'static_policy', 'main() is wrapper-owned.');
    if (!functions.has('mainImage')) throw new ContractError('policy_rejected', 'static_policy', 'mainImage entry point is missing.');
    validateBuiltinArities(tokens);
    validateBuiltinArgumentTypes(tokens);
    validateScalarFunctionSwizzles(tokens);
    validateSignalReads(tokens, definition);
    const entryIndexes = [];
    tokens.forEach(function(token, index) {
      if (token.value === 'mainImage' && tokens[index + 1] && tokens[index + 1].value === '(') entryIndexes.push(index);
    });
    if (entryIndexes.length !== 1) throw new ContractError('policy_rejected', 'static_policy', 'mainImage must be declared exactly once.');
    const entry = entryIndexes[0];
    const close = matching(tokens, entry + 1, '(', ')');
    const signature = tokens.slice(entry + 2, close).map(function(token) { return token.value; });
    if (!tokens[entry - 1] || tokens[entry - 1].value !== 'void' || canonicalize(signature) !== canonicalize(['out', 'vec4', 'fragColor', ',', 'in', 'vec2', 'fragCoord'])) {
      throw new ContractError('policy_rejected', 'static_policy', 'Entry signature must match vrch-mainimage@1.');
    }
    tokens.forEach(function(token, index) { if (token.value === 'for') validateStaticLoop(tokens, index); });
    if (values.includes('vrchSampleSource0') && definition.runtime.max_sources < 1) throw new ContractError('capability_missing', 'static_policy', 'Source A is not declared.');
    if (values.includes('vrchSampleSource1') && definition.runtime.max_sources < 2) throw new ContractError('capability_missing', 'static_policy', 'Source B is not declared.');
    if (values.filter(function(value) { return value === 'vrchSampleSignalTexture'; }).length > CONFIG.maxTextureSamples) {
      throw new ContractError('budget_exceeded', 'static_policy', 'Signal texture sample budget exceeded.');
    }
    if (values.includes('vrchFrameData') && !definition.frame) throw new ContractError('policy_rejected', 'static_policy', 'vrchFrameData needs a frame stage.');
    if (values.includes('vrchCoarseData') && !definition.coarse) throw new ContractError('policy_rejected', 'static_policy', 'vrchCoarseData needs a coarse stage.');
    let used = definition.frame ? values.concat(validateStagePolicy(definition, STAGES.frame, functions)) : values;
    if (definition.coarse) used = used.concat(validateStagePolicy(definition, STAGES.coarse, functions));
    const unusedParameters = definition.parameters.filter(function(parameter) {
      return !used.includes('uParam_' + parameter.key) && !(['float', 'int'].includes(parameter.type) && used.includes('vrchPhase_' + parameter.key));
    }).map(function(parameter) { return parameter.key; });
    if (unusedParameters.length) throw new ContractError('policy_rejected', 'static_policy', 'Declared parameters are unused by the fragment: ' + unusedParameters.join(', ') + '.');
    const graph = new Map();
    functions.forEach(function(range, name) {
      const calls = new Set();
      const body = tokens.slice(range.bodyStart, range.bodyEnd);
      body.forEach(function(token, index) {
        if (functions.has(token.value) && body[index + 1] && body[index + 1].value === '(') calls.add(token.value);
      });
      graph.set(name, calls);
    });
    function visit(name, path) {
      if (path.includes(name)) throw new ContractError('policy_rejected', 'static_policy', 'Recursive function call: ' + path.concat(name).join(' -> ') + '.');
      graph.get(name).forEach(function(child) { visit(child, path.concat(name)); });
    }
    graph.forEach(function(_, name) { visit(name, []); });
    return { ok: true, tokens: tokens.length, functions: Array.from(functions.keys()) };
  }

  // Optional stages render before the main pass with the fragment's helper
  // functions in scope. The frame stage runs once per frame into a small float
  // texture (one vrchFrame call per texel); the coarse stage runs once per
  // divisor x divisor block of the main pass (one vrchCoarse call per block).
  const STAGES = Object.freeze({
    frame: Object.freeze({ key: 'frame', label: 'Frame', entry: 'vrchFrame', signature: ['in', 'int', 'texel', ',', 'out', 'vec4', 'value'], text: 'void vrchFrame(in int texel, out vec4 value)' }),
    coarse: Object.freeze({ key: 'coarse', label: 'Coarse', entry: 'vrchCoarse', signature: ['in', 'vec2', 'blockOrigin', ',', 'in', 'float', 'blockSize', ',', 'out', 'vec4', 'value'], text: 'void vrchCoarse(in vec2 blockOrigin, in float blockSize, out vec4 value)' })
  });

  function validateStagePolicy(definition, stage, fragmentFunctions) {
    const tokens = tokenizeGlsl(definition[stage.key].source);
    const values = tokens.map(function(token) { return token.value; });
    const forbidden = new Set(['uniform', 'layout', 'precision', 'discard', 'gl_FragDepth', 'gl_FragCoord', 'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube', 'while', 'do', 'vrchSampleSource0', 'vrchSampleSource1', 'vrchSampleSignalTexture', 'vrchFrameData', 'vrchCoarseData', 'mainImage', 'vrchFrame', 'vrchCoarse'].filter(function(value) { return value !== stage.entry; }));
    const found = Array.from(forbidden).filter(function(value) { return values.includes(value); });
    if (found.length) throw new ContractError('policy_rejected', 'static_policy', 'Forbidden ' + stage.key + ' GLSL tokens: ' + found.join(', ') + '.');
    const functions = functionRanges(tokens);
    if (functions.has('main')) throw new ContractError('policy_rejected', 'static_policy', 'main() is wrapper-owned.');
    functions.forEach(function(_, name) { if (fragmentFunctions.has(name)) throw new ContractError('policy_rejected', 'static_policy', stage.label + ' function ' + name + ' is already declared by the fragment.'); });
    validateBuiltinArities(tokens);
    validateBuiltinArgumentTypes(tokens);
    validateScalarFunctionSwizzles(tokens);
    validateSignalReads(tokens, definition);
    const entries = [];
    tokens.forEach(function(token, index) { if (token.value === stage.entry && tokens[index + 1] && tokens[index + 1].value === '(' && tokens[index - 1] && tokens[index - 1].value === 'void') entries.push(index); });
    if (entries.length !== 1) throw new ContractError('policy_rejected', 'static_policy', stage.entry + ' must be declared exactly once.');
    const close = matching(tokens, entries[0] + 1, '(', ')');
    const signature = tokens.slice(entries[0] + 2, close).map(function(token) { return token.value; });
    if (canonicalize(signature) !== canonicalize(stage.signature)) throw new ContractError('policy_rejected', 'static_policy', stage.label + ' signature must be ' + stage.text + '.');
    tokens.forEach(function(token, index) { if (token.value === 'for') validateStaticLoop(tokens, index); });
    const graph = new Map();
    functions.forEach(function(range, name) {
      const calls = new Set();
      const body = tokens.slice(range.bodyStart, range.bodyEnd);
      body.forEach(function(token, index) { if (functions.has(token.value) && body[index + 1] && body[index + 1].value === '(') calls.add(token.value); });
      graph.set(name, calls);
    });
    function visit(name, path) {
      if (path.includes(name)) throw new ContractError('policy_rejected', 'static_policy', 'Recursive function call: ' + path.concat(name).join(' -> ') + '.');
      (graph.get(name) || []).forEach(function(child) { visit(child, path.concat(name)); });
    }
    graph.forEach(function(_, name) { visit(name, []); });
    return values;
  }

  function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('schema_invalid', 'schema', label + ' must be an object.');
  }

  function assertShape(value, allowed, required, label) {
    assertObject(value, label);
    const unknown = Object.keys(value).filter(function(key) { return !allowed.includes(key); });
    if (unknown.length) throw new ContractError('schema_invalid', 'schema', label + ' contains unknown keys: ' + unknown.join(', ') + '.');
    const missing = required.filter(function(key) { return !Object.prototype.hasOwnProperty.call(value, key); });
    if (missing.length) throw new ContractError('schema_invalid', 'schema', label + ' is missing: ' + missing.join(', ') + '.');
  }

  function assertText(value, min, max, label) {
    if (typeof value !== 'string' || value.length < min || value.length > max) throw new ContractError('schema_invalid', 'schema', label + ' has an invalid length.');
  }

  function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  function exactStringArray(value, max, allowed, label, min) {
    if (!Array.isArray(value) || value.length < (min || 0) || value.length > max || value.some(function(item) { return typeof item !== 'string' || !item.length || (allowed && !allowed.includes(item)); }) || new Set(value).size !== value.length) {
      throw new ContractError('schema_invalid', 'schema', label + ' is invalid.');
    }
  }

  function validateParameterValue(parameter, value, label) {
    const type = parameter.type;
    if (type === 'float' && !finiteNumber(value)) throw new ContractError('schema_invalid', 'semantic', label + ' must be a number.');
    if (type === 'int' && (!Number.isInteger(value))) throw new ContractError('schema_invalid', 'semantic', label + ' must be an integer.');
    if (type === 'bool' && typeof value !== 'boolean') throw new ContractError('schema_invalid', 'semantic', label + ' must be boolean.');
    if (type === 'color' && (!Array.isArray(value) || ![3, 4].includes(value.length) || value.some(function(item) { return !finiteNumber(item); }))) throw new ContractError('schema_invalid', 'semantic', label + ' must be a color array.');
    if (type === 'vec2' && (!Array.isArray(value) || value.length !== 2 || value.some(function(item) { return !finiteNumber(item); }))) throw new ContractError('schema_invalid', 'semantic', label + ' must be a vec2 array.');
    if (type === 'enum' && (typeof value !== 'string' || !Array.isArray(parameter.options) || !parameter.options.includes(value))) throw new ContractError('schema_invalid', 'semantic', label + ' must be an enum option.');
    if (['float', 'int'].includes(type) && (value < parameter.min || value > parameter.max)) throw new ContractError('schema_invalid', 'semantic', label + ' is outside min/max.');
    return value;
  }

  function validateBinding(binding, parameterMap, signalMap, bindingIds, label) {
    const bindingV2 = binding && binding.binding_version === 2;
    if (bindingV2) {
      assertShape(binding,
        ['binding_version', 'binding_id', 'param_key', 'signal_id', 'signal_type', 'operator', 'depth', 'input_min', 'input_max', 'curve', 'polarity', 'attack_ms', 'release_ms', 'clamp'],
        ['binding_version', 'binding_id', 'param_key', 'signal_id', 'signal_type', 'operator', 'depth', 'input_min', 'input_max', 'curve', 'polarity', 'attack_ms', 'release_ms', 'clamp'], label);
    } else {
      assertShape(binding,
        ['binding_id', 'param_key', 'signal_id', 'signal_type', 'operator', 'amount', 'polarity', 'smoothing_ms', 'attack_ms', 'decay_ms', 'clamp'],
        ['binding_id', 'param_key', 'signal_id', 'signal_type', 'operator', 'amount', 'polarity', 'smoothing_ms', 'clamp'], label);
    }
    if (!SIGNAL_ID_RE.test(binding.binding_id || '') || binding.binding_id.length > 80 || bindingIds.has(binding.binding_id)) throw new ContractError('schema_invalid', 'semantic', label + ' has an invalid or duplicate binding_id.');
    bindingIds.add(binding.binding_id);
    const parameter = parameterMap.get(binding.param_key);
    const signal = signalMap.get(binding.signal_id);
    if (!parameter || !['float', 'int'].includes(parameter.type)) throw new ContractError('schema_invalid', 'semantic', label + ' target must be a numeric parameter.');
    if (!signal || signal.type !== binding.signal_type || !['scalar', 'trigger'].includes(binding.signal_type)) throw new ContractError('schema_invalid', 'semantic', label + ' signal is missing or has the wrong type.');
    if (!['add', 'multiply'].includes(binding.operator) || !['positive', 'negative', 'bipolar'].includes(binding.polarity) || typeof binding.clamp !== 'boolean') throw new ContractError('schema_invalid', 'schema', label + ' has invalid modulation fields.');
    if (bindingV2) {
      if (!finiteNumber(binding.depth) || binding.depth < -2 || binding.depth > 2 || !finiteNumber(binding.input_min) || !finiteNumber(binding.input_max) || binding.input_min < 0 || binding.input_min > 1 || binding.input_max <= binding.input_min || binding.input_max > 4 || !['linear', 'ease_in', 'ease_out', 'smoothstep'].includes(binding.curve)) {
        throw new ContractError('schema_invalid', 'schema', label + ' has invalid v2 depth, input window, or curve.');
      }
      if (!Number.isInteger(binding.attack_ms) || binding.attack_ms < 0 || binding.attack_ms > 5000 || !Number.isInteger(binding.release_ms) || binding.release_ms < 0 || binding.release_ms > 10000) throw new ContractError('schema_invalid', 'schema', label + ' has an invalid v2 envelope.');
    } else {
      if (!finiteNumber(binding.amount) || binding.amount < -8 || binding.amount > 8 || !Number.isInteger(binding.smoothing_ms) || binding.smoothing_ms < 0 || binding.smoothing_ms > 5000) throw new ContractError('schema_invalid', 'schema', label + ' has invalid v1 modulation fields.');
      if (binding.attack_ms !== undefined && (!Number.isInteger(binding.attack_ms) || binding.attack_ms < 0 || binding.attack_ms > 5000)) throw new ContractError('schema_invalid', 'schema', label + ' attack_ms is invalid.');
      if (binding.decay_ms !== undefined && (!Number.isInteger(binding.decay_ms) || binding.decay_ms < 0 || binding.decay_ms > 10000)) throw new ContractError('schema_invalid', 'schema', label + ' decay_ms is invalid.');
    }
  }

  function validateAudioMaster(audio) {
    if (audio && audio.contract_version === 2) {
      assertShape(audio, ['contract_version', 'enabled', 'strength', 'band_gains'], ['contract_version', 'enabled', 'strength', 'band_gains'], 'modulation_master.audio');
      assertShape(audio.band_gains, ['low', 'mid', 'high'], ['low', 'mid', 'high'], 'modulation_master.audio.band_gains');
      const gains = [audio.strength, audio.band_gains.low, audio.band_gains.mid, audio.band_gains.high];
      if (typeof audio.enabled !== 'boolean' || gains.some(function(value) { return !finiteNumber(value) || value < 0 || value > 4; })) throw new ContractError('schema_invalid', 'schema', 'Invalid v2 audio modulation master.');
      return;
    }
    assertShape(audio, ['enabled', 'gain'], ['enabled', 'gain'], 'modulation_master.audio');
    if (typeof audio.enabled !== 'boolean' || !finiteNumber(audio.gain) || audio.gain < 0 || audio.gain > 4) throw new ContractError('schema_invalid', 'schema', 'Invalid audio modulation master.');
  }

  function validateDefinition(definition, options = {}) {
    assertShape(definition,
      ['schema_version', 'scene_id', 'title', 'description', 'runtime', 'fragment', 'frame', 'coarse', 'parameters', 'ui', 'signals', 'default_bindings', 'analysis_requirements', 'quality', 'catalog', 'provenance'],
      ['schema_version', 'scene_id', 'title', 'description', 'runtime', 'fragment', 'parameters', 'signals', 'default_bindings', 'quality', 'catalog', 'provenance'], 'SceneDefinition');
    if (definition.schema_version !== 1) throw new ContractError('unsupported_version', 'schema', 'Only SceneDefinition v1 is supported.');
    if (!SCENE_ID_RE.test(definition.scene_id || '')) throw new ContractError('schema_invalid', 'schema', 'Invalid scene_id.');
    assertText(definition.title, 1, 80, 'title');
    assertText(definition.description, 1, 240, 'description');
    assertShape(definition.runtime,
      ['abi', 'abi_version', 'glsl', 'min_sources', 'max_sources', 'alpha_mode', 'working_color_space', 'missing_source_policy'],
      ['abi', 'abi_version', 'glsl', 'min_sources', 'max_sources', 'alpha_mode', 'working_color_space', 'missing_source_policy'], 'runtime');
    if (definition.runtime.abi !== CONFIG.abi || definition.runtime.abi_version !== CONFIG.abiVersion || definition.runtime.glsl !== '300-es') {
      throw new ContractError('capability_missing', 'schema', 'Unsupported Scene Runtime ABI.');
    }
    if (definition.runtime.alpha_mode !== 'straight' || definition.runtime.working_color_space !== 'linear-srgb' || definition.runtime.missing_source_policy !== 'defined-fallback') throw new ContractError('capability_missing', 'schema', 'Unsupported color, alpha, or missing-source contract.');
    if (!Number.isInteger(definition.runtime.min_sources) || !Number.isInteger(definition.runtime.max_sources) || definition.runtime.min_sources < 0 || definition.runtime.max_sources > 2 || definition.runtime.min_sources > definition.runtime.max_sources) {
      throw new ContractError('schema_invalid', 'semantic', 'Invalid source count contract.');
    }
    assertShape(definition.fragment, ['entry_point', 'source'], ['entry_point', 'source'], 'fragment');
    if (definition.fragment.entry_point !== 'mainImage' || typeof definition.fragment.source !== 'string' || definition.fragment.source.length < 32 || definition.fragment.source.length > 65536) throw new ContractError('schema_invalid', 'schema', 'Invalid fragment entry.');
    if (definition.frame !== undefined) {
      assertShape(definition.frame, ['entry_point', 'source', 'texels'], ['entry_point', 'source', 'texels'], 'frame');
      if (definition.frame.entry_point !== 'vrchFrame' || typeof definition.frame.source !== 'string' || definition.frame.source.length < 32 || utf8Size(definition.frame.source) > CONFIG.frameBytes) throw new ContractError('schema_invalid', 'schema', 'Invalid frame entry.');
      if (!Number.isInteger(definition.frame.texels) || definition.frame.texels < 1 || definition.frame.texels > CONFIG.frameTexels) throw new ContractError('budget_exceeded', 'schema', 'Frame texel budget exceeded.');
    }
    if (definition.coarse !== undefined) {
      assertShape(definition.coarse, ['entry_point', 'source', 'divisor'], ['entry_point', 'source', 'divisor'], 'coarse');
      if (definition.coarse.entry_point !== 'vrchCoarse' || typeof definition.coarse.source !== 'string' || definition.coarse.source.length < 32 || utf8Size(definition.coarse.source) > CONFIG.coarseBytes) throw new ContractError('schema_invalid', 'schema', 'Invalid coarse entry.');
      if (!CONFIG.coarseDivisors.includes(definition.coarse.divisor)) throw new ContractError('budget_exceeded', 'schema', 'Unsupported coarse divisor.');
    }
    if (!Array.isArray(definition.parameters) || definition.parameters.length > CONFIG.maxParameters) throw new ContractError('budget_exceeded', 'schema', 'Parameter budget exceeded.');
    if (!Array.isArray(definition.signals) || definition.signals.length > CONFIG.maxSignals) throw new ContractError('budget_exceeded', 'schema', 'Signal budget exceeded.');
    const parameterKeys = new Set();
    definition.parameters.forEach(function(parameter) {
      assertShape(parameter, ['key', 'label', 'type', 'default', 'min', 'max', 'step', 'options', 'widget', 'group', 'description'], ['key', 'label', 'type', 'default', 'widget', 'group', 'description'], 'parameter');
      if (!PARAMETER_KEY_RE.test(parameter.key || '') || parameter.key.length > 64 || !PARAMETER_TYPES[parameter.type]) throw new ContractError('schema_invalid', 'semantic', 'Invalid parameter definition.');
      if (parameterKeys.has(parameter.key)) throw new ContractError('schema_invalid', 'semantic', 'Duplicate parameter key.');
      parameterKeys.add(parameter.key);
      assertText(parameter.label, 1, 48, 'parameter label'); assertText(parameter.group, 1, 40, 'parameter group'); assertText(parameter.description, 1, 160, 'parameter description');
      if (!['slider', 'toggle', 'color', 'select', 'xy'].includes(parameter.widget)) throw new ContractError('schema_invalid', 'schema', 'Invalid widget for ' + parameter.key + '.');
      if (['float', 'int'].includes(parameter.type) && (!finiteNumber(parameter.min) || !finiteNumber(parameter.max) || parameter.min > parameter.max || (parameter.step !== undefined && (!finiteNumber(parameter.step) || parameter.step <= 0)))) {
        throw new ContractError('schema_invalid', 'semantic', 'Invalid numeric parameter bounds for ' + parameter.key + '.');
      }
      if (parameter.type === 'enum') exactStringArray(parameter.options, 32, null, 'enum options', 1);
      validateParameterValue(parameter, parameter.default, 'default for ' + parameter.key);
    });
    if (definition.ui !== undefined) {
      assertShape(definition.ui, ['simple_parameters'], ['simple_parameters'], 'ui');
      exactStringArray(definition.ui.simple_parameters, 4, null, 'ui simple_parameters', 1);
      definition.ui.simple_parameters.forEach(function(key) {
        if (!parameterKeys.has(key)) throw new ContractError('schema_invalid', 'semantic', 'ui simple_parameters references an unknown parameter: ' + key + '.');
      });
    }
    const signalIds = new Set();
    definition.signals.forEach(function(signal) {
      assertShape(signal, ['id', 'type', 'optional', 'default'], ['id', 'type', 'optional', 'default'], 'signal');
      if (!SIGNAL_ID_RE.test(signal.id || '') || signal.id.length < 3 || signal.id.length > 80 || !['scalar', 'trigger', 'texture'].includes(signal.type) || typeof signal.optional !== 'boolean' || !finiteNumber(signal.default) || signal.default < 0 || signal.default > 1) throw new ContractError('schema_invalid', 'semantic', 'Invalid signal declaration.');
      if (signalIds.has(signal.id)) throw new ContractError('schema_invalid', 'semantic', 'Duplicate signal id.');
      signalIds.add(signal.id);
    });
    ['scalar', 'trigger', 'texture'].forEach(function(type) {
      const limit = type === 'texture' ? 2 : 8;
      if (definition.signals.filter(function(signal) { return signal.type === type; }).length > limit) throw new ContractError('budget_exceeded', 'semantic', 'Signal type budget exceeded for ' + type + '.');
    });
    if (!Array.isArray(definition.default_bindings) || definition.default_bindings.length > 16) throw new ContractError('budget_exceeded', 'schema', 'Binding budget exceeded.');
    const parameterMap = new Map(definition.parameters.map(function(parameter) { return [parameter.key, parameter]; }));
    const signalMap = new Map(definition.signals.map(function(signal) { return [signal.id, signal]; }));
    const bindingIds = new Set();
    definition.default_bindings.forEach(function(binding, index) { validateBinding(binding, parameterMap, signalMap, bindingIds, 'default binding ' + index); });
    if (definition.analysis_requirements !== undefined) {
      if (!Array.isArray(definition.analysis_requirements) || definition.analysis_requirements.length > 2) throw new ContractError('budget_exceeded', 'schema', 'Analysis requirement budget exceeded.');
      definition.analysis_requirements.forEach(function(requirement, index) {
        assertShape(requirement, ['kind', 'source_input', 'topology', 'history_ms'], ['kind', 'source_input', 'topology', 'history_ms'], 'analysis requirement ' + index);
        const analysisTopologies = { hand: 'vrch.hand-landmarks@1', face: 'vrch.face-landmarks@1', pose: 'vrch.pose-landmarks@1' };
        if (!analysisTopologies[requirement.kind] || requirement.topology !== analysisTopologies[requirement.kind] || !Number.isInteger(requirement.source_input) || requirement.source_input < 0 || requirement.source_input > 1 || !Number.isInteger(requirement.history_ms) || requirement.history_ms < 0 || requirement.history_ms > 2000) {
          throw new ContractError('schema_invalid', 'semantic', 'Invalid analysis requirement ' + index + '.');
        }
        if (requirement.source_input >= definition.runtime.max_sources) throw new ContractError('capability_missing', 'semantic', 'Analysis source input is outside the declared source contract.');
      });
    }
    assertShape(definition.quality, ['cost_hint', 'profiles'], ['cost_hint', 'profiles'], 'quality');
    if (!['low', 'medium', 'high'].includes(definition.quality.cost_hint)) throw new ContractError('schema_invalid', 'schema', 'Invalid quality cost_hint.');
    assertShape(definition.quality.profiles, ['edge', 'standard', 'high'], ['edge', 'standard', 'high'], 'quality profiles');
    ['edge', 'standard', 'high'].forEach(function(profile) {
      const value = definition.quality.profiles[profile];
      assertShape(value, ['variant', 'preferred_scale'], ['variant', 'preferred_scale'], 'quality ' + profile);
      if (value.variant !== profile || !finiteNumber(value.preferred_scale) || value.preferred_scale < 0.25 || value.preferred_scale > 1) throw new ContractError('schema_invalid', 'schema', 'Invalid quality profile ' + profile + '.');
    });
    assertShape(definition.catalog, ['category', 'tags', 'thumbnail_ref', 'roles'], ['category', 'tags', 'thumbnail_ref', 'roles'], 'catalog');
    if (!['Generate', 'Filter', 'Blend'].includes(definition.catalog.category)) throw new ContractError('schema_invalid', 'schema', 'Invalid catalog category.');
    exactStringArray(definition.catalog.tags, 16, null, 'catalog tags', 0);
    definition.catalog.tags.forEach(function(tag) { assertText(tag, 1, 32, 'catalog tag'); });
    assertText(definition.catalog.thumbnail_ref, 0, 240, 'thumbnail_ref');
    exactStringArray(definition.catalog.roles, 4, ['engineering-fixture', 'product-baseline', 'beta-gate', 'experience-example'], 'catalog roles', 1);
    assertShape(definition.provenance, ['kind', 'base_scene_ref', 'prompt_summary', 'authoring_request_ref', 'model_mode', 'template_version', 'created_at'], ['kind', 'created_at'], 'provenance');
    if (!['builtin', 'ai-derived', 'human-edit', 'migrated'].includes(definition.provenance.kind) || typeof definition.provenance.created_at !== 'string' || Number.isNaN(Date.parse(definition.provenance.created_at))) throw new ContractError('schema_invalid', 'schema', 'Invalid provenance.');
    const namespace = definition.scene_id.split('.')[0];
    const provenance = definition.provenance && definition.provenance.kind;
    if ((provenance === 'builtin' && namespace !== 'vrch') || (['ai-derived', 'human-edit'].includes(provenance) && namespace !== 'user') || (provenance === 'migrated' && namespace !== 'legacy')) {
      throw new ContractError('schema_invalid', 'semantic', 'Scene namespace cannot elevate provenance.');
    }
    if (utf8Size(definition) > CONFIG.definitionBytes) throw new ContractError('message_too_large', 'schema', 'Canonical SceneDefinition exceeds 80 KiB.');
    validateFragmentPolicy(definition, options);
    return { ok: true };
  }

  function parameterDefaultMap(definition) {
    const values = {};
    definition.parameters.forEach(function(parameter) { values[parameter.key] = structuredClone(parameter.default); });
    return values;
  }

  function normalizeInstance(definition, instance, options = {}) {
    validateDefinition(definition, options);
    assertShape(instance, ['schema_version', 'instance_id', 'scene_ref', 'params', 'bindings', 'modulation_master', 'quality_mode'], ['schema_version', 'instance_id', 'scene_ref', 'params', 'bindings', 'modulation_master', 'quality_mode'], 'SceneInstance');
    if (instance.schema_version !== 1 || typeof instance.instance_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(instance.instance_id)) throw new ContractError('schema_invalid', 'schema', 'Invalid SceneInstance identity.');
    assertShape(instance.scene_ref, ['scene_id', 'content_hash'], ['scene_id', 'content_hash'], 'scene_ref');
    if (instance.scene_ref.scene_id !== definition.scene_id || !HASH_RE.test(instance.scene_ref.content_hash || '')) throw new ContractError('schema_invalid', 'semantic', 'SceneInstance scene_ref is invalid.');
    assertObject(instance.params, 'params');
    if (Object.keys(instance.params).length > CONFIG.maxParameters) throw new ContractError('budget_exceeded', 'schema', 'Instance parameter budget exceeded.');
    const normalized = structuredClone(instance);
    const definitions = new Map(definition.parameters.map(function(parameter) { return [parameter.key, parameter]; }));
    const params = parameterDefaultMap(definition);
    Object.keys(instance.params || {}).forEach(function(key) {
      const parameter = definitions.get(key);
      if (!parameter) throw new ContractError('schema_invalid', 'semantic', 'Unknown parameter ' + key + '.');
      let value = instance.params[key];
      if (parameter.type === 'float') value = Number(value);
      if (parameter.type === 'int') value = Math.round(Number(value));
      validateParameterValue(parameter, value, 'instance param ' + key);
      if (['float', 'int'].includes(parameter.type)) value = Math.min(parameter.max, Math.max(parameter.min, value));
      params[key] = value;
    });
    normalized.params = params;
    if (!Array.isArray(instance.bindings) || instance.bindings.length > 16) throw new ContractError('budget_exceeded', 'schema', 'Instance binding budget exceeded.');
    const signalMap = new Map(definition.signals.map(function(signal) { return [signal.id, signal]; }));
    const bindingIds = new Set();
    instance.bindings.forEach(function(binding, index) { validateBinding(binding, definitions, signalMap, bindingIds, 'instance binding ' + index); });
    assertShape(instance.modulation_master, ['audio'], ['audio'], 'modulation_master');
    validateAudioMaster(instance.modulation_master.audio);
    if (!['auto', 'edge', 'standard', 'high'].includes(instance.quality_mode)) throw new ContractError('schema_invalid', 'schema', 'Invalid quality_mode.');
    if (utf8Size(normalized) > CONFIG.instanceBytes) throw new ContractError('message_too_large', 'schema', 'Canonical SceneInstance exceeds 8 KiB.');
    return normalized;
  }

  function uniformValue(parameter, value) {
    if (parameter.type === 'color') return Array.isArray(value) && value.length === 3 ? value.concat(1) : value;
    if (parameter.type === 'enum') return Math.max(0, (parameter.options || []).indexOf(value));
    return value;
  }

  function buildFragmentShader(definition, options = {}) {
    validateDefinition(definition, options);
    const frameStage = options.stage === 'frame';
    const coarseStage = options.stage === 'coarse';
    if (frameStage && !definition.frame) throw new ContractError('schema_invalid', 'schema', 'The definition has no frame stage.');
    if (coarseStage && !definition.coarse) throw new ContractError('schema_invalid', 'schema', 'The definition has no coarse stage.');
    // Main pass: vrchFrameData reads this frame's texel; frame pass: it is not
    // available and vrchFrame writes one texel per fragment. The coarse pass
    // runs between them: vrchCoarseData reads the block of a main-pass
    // fragment, and vrchCoarse writes one block per coarse fragment.
    const frameDeclaration = !definition.frame ? '' : frameStage
      ? 'vec4 vrchFrameData(int index) { return vec4(0.0); }\n'
      : 'uniform highp sampler2D uVrchFrameData;\nvec4 vrchFrameData(int index) { return texelFetch(uVrchFrameData, ivec2(index, 0), 0); }\n';
    const divisor = definition.coarse ? definition.coarse.divisor : 1;
    const coarseDeclaration = !definition.coarse ? '' : (frameStage || coarseStage)
      ? 'vec4 vrchCoarseData(vec2 fragCoord) { return vec4(0.0); }\n'
      : 'uniform highp sampler2D uVrchCoarseData;\nvec4 vrchCoarseData(vec2 fragCoord) { return texelFetch(uVrchCoarseData, ivec2(fragCoord) / ' + divisor + ', 0); }\n';
    const frameSource = frameStage ? '\n#line 1 2\n' + definition.frame.source : coarseStage ? '\n#line 1 3\n' + definition.coarse.source : '';
    const entry = coarseStage ? `void main() {
  vec4 value = vec4(0.0);
  vrchCoarse(floor(gl_FragCoord.xy) * ${divisor}.0, ${divisor}.0, value);
  vrchFragColor = value;
}` : frameStage ? `void main() {
  vec4 value = vec4(0.0);
  vrchFrame(int(gl_FragCoord.x), value);
  vrchFragColor = value;
}` : `void main() {
  vec4 color = vec4(0.0);
  mainImage(color, gl_FragCoord.xy);
  if (any(isnan(color)) || any(isinf(color))) color = vec4(0.0, 0.0, 0.0, 1.0);
  color = clamp(color, 0.0, 1.0);
  vrchFragColor = vec4(vrchLinearToSrgb(color.rgb), color.a);
}`;
    const parameterUniforms = definition.parameters.map(function(parameter) {
      return 'uniform ' + PARAMETER_TYPES[parameter.type] + ' uParam_' + parameter.key + ';';
    }).join('\n');
    const parameterPhases = definition.parameters.filter(function(parameter) { return ['float', 'int'].includes(parameter.type); }).map(function(parameter) {
      return 'uniform float uVrchPhase_' + parameter.key + ';\nfloat vrchPhase_' + parameter.key + '() { return uVrchPhasesValid ? uVrchPhase_' + parameter.key + ' : iTime * float(uParam_' + parameter.key + '); }';
    }).join('\n');
    return `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform vec2 uVrchViewportResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform bool uVrchPhasesValid;
uniform sampler2D uVrchSource0;
uniform sampler2D uVrchSource1;
uniform bool uVrchSource0Valid;
uniform bool uVrchSource1Valid;
uniform bool uVrchSource0Stale;
uniform bool uVrchSource1Stale;
uniform vec2 uVrchSource0Resolution;
uniform vec2 uVrchSource1Resolution;
uniform float uVrchSource0Age;
uniform float uVrchSource1Age;
uniform int uVrchSource0Fit;
uniform int uVrchSource1Fit;
uniform vec4 uVrchSource0Crop;
uniform vec4 uVrchSource1Crop;
uniform int uVrchSource0Rotation;
uniform int uVrchSource1Rotation;
uniform vec2 uVrchSource0Mirror;
uniform vec2 uVrchSource1Mirror;
uniform bool uVrchSource0OriginTopLeft;
uniform bool uVrchSource1OriginTopLeft;
// Runtime-prepared affine placement, used when VRCH_PLACED_SOURCES is defined:
// map 1 places affinely; map 2 also returns transparent outside the image;
// maps 3 (repeat) and 4 (mirror) tile: Affine/Shift give the tile coordinate,
// its fraction goes through Post (rows) and Tile.xy, Tile.zw maps uv.y to the
// mirrored row coordinate.
uniform int uVrchSource0Map;
uniform int uVrchSource1Map;
uniform vec4 uVrchSource0Affine;
uniform vec4 uVrchSource1Affine;
uniform vec2 uVrchSource0Shift;
uniform vec2 uVrchSource1Shift;
uniform vec4 uVrchSource0Texel;
uniform vec4 uVrchSource1Texel;
uniform vec4 uVrchSource0Post;
uniform vec4 uVrchSource1Post;
uniform vec4 uVrchSource0Tile;
uniform vec4 uVrchSource1Tile;
uniform int uVrchTileAnchor;
uniform float uVrchSignals[16];
uniform sampler2D uVrchSignalTexture0;
uniform sampler2D uVrchSignalTexture1;
uniform bool uVrchSignalTexture0Valid;
uniform bool uVrchSignalTexture1Valid;
${parameterUniforms}
${parameterPhases}
out vec4 vrchFragColor;
vec3 vrchSrgbToLinear(vec3 value) {
  vec3 low = value / 12.92;
  vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, lessThanEqual(value, vec3(0.04045)));
}
// Source textures uploaded as sRGB (VRCH_SRGB_SOURCES) are decoded by the
// texture unit; otherwise the sample is decoded here.
vec3 vrchSourceToLinear(vec3 value) {
#ifdef VRCH_SRGB_SOURCES
  return value;
#else
  return vrchSrgbToLinear(value);
#endif
}
vec3 vrchLinearToSrgb(vec3 value) {
  value = max(value, vec3(0.0));
  vec3 low = value * 12.92;
  vec3 high = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, lessThanEqual(value, vec3(0.0031308)));
}
vec4 vrchMissingSource(vec2 uv, float slot) {
  vec2 grid = floor(clamp(uv, 0.0, 1.0) * 12.0);
  float checker = mod(grid.x + grid.y + slot, 2.0);
  return vec4(mix(vec3(0.018), vec3(0.04), checker), 1.0);
}
#ifdef VRCH_PLACED_SOURCES
// The runtime prepares every placement as affine maps once per frame.
// It also names each source's current map at compile time (VRCH_SOURCE0_MAP,
// VRCH_SOURCE1_MAP), so every sample compiles to that map's path alone.
#ifndef VRCH_SOURCE0_MAP
#define VRCH_SOURCE0_MAP uVrchSource0Map
#endif
#ifndef VRCH_SOURCE1_MAP
#define VRCH_SOURCE1_MAP uVrchSource1Map
#endif
vec4 vrchReadPlacedSource(sampler2D sourceTexture, bool valid, int mapMode, vec4 affine, vec2 shift, vec4 texel, vec4 post, vec4 tile, vec2 uv, float slot) {
  if (!valid) return vrchMissingSource(uv, slot);
  vec2 placed = vec2(dot(affine.xy, uv), dot(affine.zw, uv)) + shift;
  if (mapMode >= 3) {
    vec2 cell = floor(placed);
    vec2 inTile = placed - cell;
    if (mapMode == 4) inTile = mix(inTile, vec2(1.0) - inTile, mod(abs(vec2(cell.x, floor(tile.z * uv.y + tile.w))), vec2(2.0)));
    placed = vec2(dot(post.xy, inTile), dot(post.zw, inTile)) + tile.xy;
  } else if (mapMode == 2 && (any(lessThan(placed, vec2(0.0))) || any(greaterThan(placed, vec2(1.0))))) return vec4(0.0);
  vec4 sampleValue = texture(sourceTexture, clamp(placed, 0.0, 1.0) * texel.xy + texel.zw);
  return vec4(vrchSourceToLinear(sampleValue.rgb), sampleValue.a);
}
vec4 vrchSampleSource0(vec2 uv) { return vrchReadPlacedSource(uVrchSource0, uVrchSource0Valid, VRCH_SOURCE0_MAP, uVrchSource0Affine, uVrchSource0Shift, uVrchSource0Texel, uVrchSource0Post, uVrchSource0Tile, uv, 0.0); }
vec4 vrchSampleSource1(vec2 uv) { return vrchReadPlacedSource(uVrchSource1, uVrchSource1Valid, VRCH_SOURCE1_MAP, uVrchSource1Affine, uVrchSource1Shift, uVrchSource1Texel, uVrchSource1Post, uVrchSource1Tile, uv, 1.0); }
#else
vec2 vrchMapSourceUv(vec2 uv, vec2 sourceResolution, int fitMode, vec4 crop, int rotation, vec2 mirrorValue, out bool inside) {
  vec2 croppedResolution = max(vec2(1.0), sourceResolution * crop.zw);
  if (rotation == 1 || rotation == 3) croppedResolution = croppedResolution.yx;
  vec2 viewportResolution = max(uVrchViewportResolution, vec2(1.0));
  float outputAspect = viewportResolution.x / viewportResolution.y;
  float sourceAspect = croppedResolution.x / max(1.0, croppedResolution.y);
  vec2 mapped = uv;
  inside = true;
  if (fitMode == 0) {
    if (outputAspect > sourceAspect) {
      float width = sourceAspect / outputAspect;
      mapped.x = (uv.x - 0.5) / width + 0.5;
    } else {
      float height = outputAspect / sourceAspect;
      mapped.y = (uv.y - 0.5) / height + 0.5;
    }
    inside = all(greaterThanEqual(mapped, vec2(0.0))) && all(lessThanEqual(mapped, vec2(1.0)));
  } else if (fitMode == 1) {
    if (outputAspect > sourceAspect) mapped.y = (uv.y - 0.5) * (sourceAspect / outputAspect) + 0.5;
    else mapped.x = (uv.x - 0.5) * (outputAspect / sourceAspect) + 0.5;
  } else if (fitMode == 3) {
    // Match the V1 BasicFade camera contract: the original-size plane is
    // 200 world units high in a 45-degree camera positioned at z=300.
    const float vrchOriginalHeight = 0.8047378541;
    vec2 originalScale = vec2(vrchOriginalHeight * sourceAspect / outputAspect, vrchOriginalHeight);
    mapped = (uv - 0.5) / max(originalScale, vec2(0.000001)) + 0.5;
    inside = all(greaterThanEqual(mapped, vec2(0.0))) && all(lessThanEqual(mapped, vec2(1.0)));
  } else if (fitMode == 4 || fitMode == 5) {
    // V1 builds tile cells in CSS pixels before uploading the texture. Keep
    // that geometry independent from renderer DPR and drawing-buffer size.
    vec2 tileCount = max(viewportResolution / croppedResolution, vec2(0.000001));
    vec2 tileCoord = (uv - 0.5) * tileCount + 0.5;
    if (uVrchTileAnchor == 1) tileCoord = vec2(uv.x * tileCount.x, (uv.y - 1.0) * tileCount.y + 1.0);
    else if (uVrchTileAnchor == 2) tileCoord = (uv - 0.5) * tileCount + 1.0;
    vec2 tileCell = floor(tileCoord);
    mapped = fract(tileCoord);
    if (fitMode == 5) {
      // Mirrored row parity is defined by the V1 2D tiler in top-left CSS
      // coordinates. Sampling UV remains lower-left, so derive only the row
      // index from the equivalent top-left tile coordinate.
      float mirrorRowCoord = (1.0 - uv.y) * tileCount.y;
      if (uVrchTileAnchor == 0) mirrorRowCoord -= (tileCount.y - 1.0) * 0.5;
      else if (uVrchTileAnchor == 2) mirrorRowCoord -= tileCount.y * 0.5 - 1.0;
      vec2 mirrorCell = vec2(tileCell.x, floor(mirrorRowCoord));
      vec2 flipCell = mod(abs(mirrorCell), vec2(2.0));
      mapped = mix(mapped, vec2(1.0) - mapped, flipCell);
    }
  }
  if (mirrorValue.x > 0.5) mapped.x = 1.0 - mapped.x;
  if (mirrorValue.y > 0.5) mapped.y = 1.0 - mapped.y;
  if (rotation == 1) mapped = vec2(mapped.y, 1.0 - mapped.x);
  else if (rotation == 2) mapped = vec2(1.0) - mapped;
  else if (rotation == 3) mapped = vec2(1.0 - mapped.y, mapped.x);
  return crop.xy + clamp(mapped, 0.0, 1.0) * crop.zw;
}
vec4 vrchReadSource(sampler2D sourceTexture, bool valid, vec2 resolution, int fitMode, vec4 crop, int rotation, vec2 mirrorValue, bool originTopLeft, vec2 uv, float slot) {
  bool inside = true;
  vec2 sourceUv = vrchMapSourceUv(uv, resolution, fitMode, crop, rotation, mirrorValue, inside);
  if (!valid) return vrchMissingSource(uv, slot);
  if (!inside) return vec4(0.0);
  if (originTopLeft) sourceUv.y = 1.0 - sourceUv.y;
  vec4 sampleValue = texture(sourceTexture, sourceUv);
  return vec4(vrchSourceToLinear(sampleValue.rgb), sampleValue.a);
}
vec4 vrchSampleSource0(vec2 uv) { return vrchReadSource(uVrchSource0, uVrchSource0Valid, uVrchSource0Resolution, uVrchSource0Fit, uVrchSource0Crop, uVrchSource0Rotation, uVrchSource0Mirror, uVrchSource0OriginTopLeft, uv, 0.0); }
vec4 vrchSampleSource1(vec2 uv) { return vrchReadSource(uVrchSource1, uVrchSource1Valid, uVrchSource1Resolution, uVrchSource1Fit, uVrchSource1Crop, uVrchSource1Rotation, uVrchSource1Mirror, uVrchSource1OriginTopLeft, uv, 1.0); }
#endif
float vrchReadSignal(int signalIndex) { return signalIndex >= 0 && signalIndex < 16 ? uVrchSignals[signalIndex] : 0.0; }
vec4 vrchSampleSignalTexture(int signalIndex, vec2 uv) {
  if (signalIndex == 0 && uVrchSignalTexture0Valid) return texture(uVrchSignalTexture0, clamp(uv, 0.0, 1.0));
  if (signalIndex == 1 && uVrchSignalTexture1Valid) return texture(uVrchSignalTexture1, clamp(uv, 0.0, 1.0));
  return vec4(0.0);
}
${frameDeclaration}${coarseDeclaration}#line 1 0
${definition.fragment.source}${frameSource}
#line 1 1
${entry}`;
  }

  function buildFrameShader(definition, options = {}) {
    return buildFragmentShader(definition, Object.assign({}, options, { stage: 'frame' }));
  }

  function buildCoarseShader(definition, options = {}) {
    return buildFragmentShader(definition, Object.assign({}, options, { stage: 'coarse' }));
  }

  function buildVertexShader() {
    return `#version 300 es
precision highp float;
in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }`;
  }

  function makeUniformSpec(definition, instance, options = {}) {
    const normalized = normalizeInstance(definition, instance, options);
    const spec = {};
    definition.parameters.forEach(function(parameter) {
      spec['uParam_' + parameter.key] = { type: PARAMETER_TYPES[parameter.type], value: uniformValue(parameter, normalized.params[parameter.key]) };
      if (['float', 'int'].includes(parameter.type)) spec['uVrchPhase_' + parameter.key] = { type: 'float', value: 0 };
    });
    return spec;
  }

  class ParameterPhaseClock {
    constructor(definition) {
      const names = new Set(tokenizeGlsl(definition.fragment.source + (definition.frame ? '\n' + definition.frame.source : '') + (definition.coarse ? '\n' + definition.coarse.source : '')).map(function(token) { return token.value; }));
      this.keys = definition.parameters.filter(function(parameter) {
        return ['float', 'int'].includes(parameter.type) && names.has('vrchPhase_' + parameter.key);
      }).map(function(parameter) { return parameter.key; });
      this.reset();
    }

    reset() {
      this.values = Object.fromEntries(this.keys.map(function(key) { return [key, 0]; }));
      this.previous = null;
    }

    update(params, deltaSeconds) {
      const delta = Math.max(0, Math.min(0.1, Number(deltaSeconds) || 0));
      this.keys.forEach((key) => {
        const rate = Number.isFinite(params[key]) ? params[key] : 0;
        if (this.previous) this.values[key] += (this.previous[key] + rate) * 0.5 * delta;
      });
      this.previous = Object.fromEntries(this.keys.map(function(key) { return [key, Number.isFinite(params[key]) ? params[key] : 0]; }));
      return this.values;
    }
  }

  function makeSenderId(senderType) {
    const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
    return senderType + ':' + uuid;
  }

  function createEnvelope(options) {
    const envelope = {
      protocol: CONFIG.protocol,
      protocol_version: CONFIG.protocolVersion,
      message_id: options.messageId,
      request_id: options.requestId == null ? null : options.requestId,
      in_reply_to: options.inReplyTo == null ? null : options.inReplyTo,
      transaction_id: options.transactionId == null ? null : options.transactionId,
      target_viewer_id: options.targetViewerId,
      recipient_sender_id: options.recipientSenderId == null ? null : options.recipientSenderId,
      sender_id: options.senderId,
      sender_type: options.senderType,
      sender_display_label: options.senderDisplayLabel,
      base_revision_id: options.baseRevisionId == null ? null : options.baseRevisionId,
      type: options.type,
      sent_at: options.sentAt || new Date().toISOString(),
      payload: options.payload || {}
    };
    if (utf8Size(envelope) > CONFIG.envelopeBytes) throw new ContractError('message_too_large', 'envelope', 'Envelope exceeds 96 KiB.');
    return envelope;
  }

  function shouldAcceptEnvelope(envelope, context) {
    if (!envelope || envelope.protocol !== CONFIG.protocol || envelope.protocol_version !== CONFIG.protocolVersion) return false;
    const matchesTarget = envelope.target_viewer_id === context.targetViewerId ||
      (context.role === 'viewer' && envelope.target_viewer_id === '*');
    if (!matchesTarget) return false;
    if (envelope.sender_id === context.senderId) return false;
    if (envelope.recipient_sender_id != null && envelope.recipient_sender_id !== context.senderId) return false;
    if (context.role === 'viewer') {
      return envelope.recipient_sender_id == null &&
        CONTROLLER_SENDER_TYPES.has(envelope.sender_type) &&
        CLIENT_TO_VIEWER_TYPES.has(envelope.type);
    }
    if (!VIEWER_SENDER_TYPES.has(envelope.sender_type) || !VIEWER_TO_CLIENT_TYPES.has(envelope.type)) return false;
    if (envelope.in_reply_to && context.pendingMessageIds && !context.pendingMessageIds.has(envelope.in_reply_to)) {
      if (!['state.snapshot', 'state.changed', 'draft.updated', 'scene.committed', 'scene.aborted', 'scene.preview_main.result', 'transaction.handoff.requested', 'transaction.handoff.result', 'transaction.takeover.result'].includes(envelope.type)) return false;
    }
    return true;
  }

  return Object.freeze({
    CONFIG: CONFIG,
    ContractError: ContractError,
    canonicalize: canonicalize,
    utf8Size: utf8Size,
    sha256Ref: sha256Ref,
    tokenizeGlsl: tokenizeGlsl,
    validateFragmentPolicy: validateFragmentPolicy,
    validateDefinition: validateDefinition,
    normalizeInstance: normalizeInstance,
    parameterDefaultMap: parameterDefaultMap,
    buildFragmentShader: buildFragmentShader,
    buildFrameShader: buildFrameShader,
    buildCoarseShader: buildCoarseShader,
    buildVertexShader: buildVertexShader,
    makeUniformSpec: makeUniformSpec,
    ParameterPhaseClock: ParameterPhaseClock,
    makeSenderId: makeSenderId,
    createEnvelope: createEnvelope,
    shouldAcceptEnvelope: shouldAcceptEnvelope,
    VIEWER_SENDER_TYPES: VIEWER_SENDER_TYPES,
    CONTROLLER_SENDER_TYPES: CONTROLLER_SENDER_TYPES,
    CLIENT_TO_VIEWER_TYPES: CLIENT_TO_VIEWER_TYPES,
    VIEWER_TO_CLIENT_TYPES: VIEWER_TO_CLIENT_TYPES
  });
});

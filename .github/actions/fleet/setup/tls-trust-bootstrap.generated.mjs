#!/usr/bin/env node
import { createRequire } from "node:module";
import crypto from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process$1 from "node:process";
import { constants, lstatSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { execFile } from "node:child_process";
import { getCACertificates } from "node:tls";
import { promisify } from "node:util";

var __commonJSMin$1 = (cb, mod) => () => (
  mod || (cb((mod = { exports: {} }).exports, mod, mod.exports), (cb = null)),
  mod.exports
);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

/**
 * @file Entrypoint detection for fleet scripts. The naive
 *   `import.meta.url === file://argv[1]` comparison is symlink-fragile:
 *   Node resolves the REAL path for a module's `import.meta.url` while
 *   `process.argv[1]` keeps the path as invoked, so a script spawned via a
 *   symlinked location (macOS `/var` → `/private/var`, the shape every
 *   mkdtemp-based integration test hits) never matches and `main()` silently
 *   does not run. Compare realpaths on both sides instead.
 *   V8 startup-snapshot guard: when a fleet script is bundled into the
 *   snapshot dispatch pack (e.g. `ai-balancer/probe.mts` is imported by the
 *   `ai-balancer-proxy-start` hook), `node --build-snapshot <bundle.cjs>`
 *   sets `process.argv[1]` to the bundle path. A bundled module's
 *   `import.meta.url` is rewritten to `pathToFileURL(__filename).href`, which
 *   also resolves to the bundle path, so `isMainModule` returns true and
 *   `runMain(main)` fires at module-eval — calling `probeHealth()` which
 *   loads `node:http`, creating `HTTPParser` and `net.Socket` native handles
 *   V8 refuses to serialize (`CheckGlobalAndEternalHandles` fatal). The
 *   guard mirrors `isGuardRunContext` in `guard.mts`: a snapshot BUILD pass
 *   is never a run context for a standalone script.
 */
/**
 * True when the module at `importMetaUrl` is the process entrypoint.
 * `entryPath` defaults to `process.argv[1]`; injectable for tests.
 *
 * Returns false during a V8 `--build-snapshot` pass: a bundled script's
 * `import.meta.url` and `process.argv[1]` both resolve to the bundle file,
 * so the entrypoint test would hold and `runMain` would execute `main()` at
 * module-eval — loading `node:http` (native `HTTPParser` / `Socket` handles
 * V8 refuses to serialize) and aborting `CheckGlobalAndEternalHandles`. A
 * deserialized process sees the real entrypoint comparison.
 */
function isMainModule(importMetaUrl, entryPath) {
  if (v8.startupSnapshot.isBuildingSnapshot()) return false;
  const entry = entryPath ?? process$1.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

var require_sentinels = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  /**
   * @file Core primitives and fundamental constants. Holds sentinels,
   *   unknown/empty tokens, the internals symbol, and a few shared env-var name
   *   strings. Intentionally kept small - prefer moving constants to a more
   *   specific `src/constants/*` module when possible.
   */
  const kInternalsSymbol = Symbol("@socketregistry.constants.internals");
  const LOOP_SENTINEL = 1e6;
  const UNKNOWN_ERROR = "Unknown error";
  const UNKNOWN_VALUE = "<unknown>";
  const EMPTY_FILE = "/* empty */\n";
  const EMPTY_VALUE = "<value>";
  const UNDEFINED_TOKEN = void 0;
  const COLUMN_LIMIT = 80;
  const V = "v";
  const NODE_AUTH_TOKEN = "NODE_AUTH_TOKEN";
  const NODE_ENV = "NODE_ENV";
  exports.COLUMN_LIMIT = COLUMN_LIMIT;
  exports.EMPTY_FILE = EMPTY_FILE;
  exports.EMPTY_VALUE = EMPTY_VALUE;
  exports.LOOP_SENTINEL = LOOP_SENTINEL;
  exports.NODE_AUTH_TOKEN = NODE_AUTH_TOKEN;
  exports.NODE_ENV = NODE_ENV;
  exports.UNDEFINED_TOKEN = UNDEFINED_TOKEN;
  exports.UNKNOWN_ERROR = UNKNOWN_ERROR;
  exports.UNKNOWN_VALUE = UNKNOWN_VALUE;
  exports.V = V;
  exports.kInternalsSymbol = kInternalsSymbol;
});

var require_runtime = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  /**
   * @file Runtime environment detection constants. All checks use only
   *   `typeof`-safe global probes so this module is safe to import in browser,
   *   Node.js, Deno, Bun, and bundled contexts alike.
   */
  /**
   * True when running inside a Node.js process. Detected via
   * `process.versions.node` — present in Node, absent in browsers and Deno/Bun
   * which expose a different `process.versions` shape (or no `process` at all).
   */
  const IS_NODE =
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    typeof process.versions.node === "string";
  /**
   * True when running in a browser context (window + document both defined).
   * Note: Chrome extensions have `window` in popup contexts but not in service
   * workers — check `IS_SERVICE_WORKER` for that case.
   */
  const IS_BROWSER =
    typeof globalThis !== "undefined" &&
    "window" in globalThis &&
    typeof globalThis.window !== "undefined" &&
    "document" in globalThis &&
    typeof globalThis.document !== "undefined";
  /**
   * True when running inside a Web Worker / Chrome MV3 service worker. `self` is
   * defined without `window` in worker contexts.
   */
  const IS_WORKER =
    "self" in globalThis &&
    typeof globalThis.self !== "undefined" &&
    !("window" in globalThis) &&
    !("document" in globalThis);
  exports.IS_BROWSER = IS_BROWSER;
  exports.IS_NODE = IS_NODE;
  exports.IS_WORKER = IS_WORKER;
});

var require_module = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_constants_runtime = require_runtime();
  let module$1 = __require("module");
  /**
   * @file Accessors for `node:module` that work across runtimes. Ambient
   *   `require` is bound in CommonJS but unbound in ESM and inside
   *   ahead-of-time-compiled package modules (e.g. Perry), where reading it
   *   throws. And Perry's `require('module')` value omits `isBuiltin`. So instead
   *   of the ambient `require('module')` lazy-loader, `isBuiltin`/`createRequire`
   *   are imported as named values from the bare `module` specifier — which
   *   resolves on Node and Perry, and which browser bundlers can stub via
   *   resolve.fallback (a `node:` prefix would throw UnhandledSchemeError
   *   there).
   *   `require` is DIRECTORY-SPECIFIC: `createRequire(base)` resolves relative
   *   specifiers (`./x`, `../y`) from `base`'s directory. For builtins and bare
   *   packages that's irrelevant since they resolve the same anywhere, so the
   *   cached `getRequire` / `requireBuiltin` bind to THIS file. A RELATIVE
   *   specifier must resolve from the CALLER's directory, so use `requireFrom`
   *   with the caller's `import.meta.url` — binding such a load to this file
   *   would resolve it against `src/node/` instead. Bundled, every module
   *   collapses to one base and either works; unbundled (e.g. AOT-compiled from
   *   source), each module sits at its own nested path and the base matters.
   */
  let cachedModule;
  let cachedRequire;
  /**
   * Bind a working `require`. Ambient `require` exists in CommonJS; in ESM and
   * ahead-of-time-compiled package modules it is unbound (reading it throws or
   * yields undefined), so fall back to `createRequire`. Returns undefined off
   * Node and in browsers, where neither is available.
   *
   * `fromUrl` sets the resolution base — pass a caller's `import.meta.url` to
   * resolve that caller's RELATIVE specifiers. When omitted, the base is this
   * file, which is correct only for builtins / bare packages (dir-independent).
   * With `fromUrl` the ambient `require` is skipped: it is bound to THIS file, so
   * it would resolve a relative specifier from the wrong directory.
   */
  function bindRequire(fromUrl) {
    if (!require_constants_runtime.IS_NODE) return;
    if (!fromUrl && typeof __require === "function") return __require;
    if (typeof module$1.createRequire === "function")
      try {
        return (0, module$1.createRequire)(
          fromUrl ?? __require("url").pathToFileURL(__filename).href,
        );
      } catch {
        return;
      }
  }
  /**
   * Returns `node:module` loaded through the bound `require`, or undefined off
   * Node. Cached across calls.
   */
  function getNodeModule() {
    return (cachedModule ??= requireBuiltin("module"));
  }
  /**
   * Returns a working `require` bound to THIS file, binding one on first call
   * (see bindRequire). Cached across calls; undefined off Node / in browsers.
   *
   * For builtins and bare packages only — the resolution base is this file, so a
   * relative specifier would resolve from `src/node/`. Use `requireFrom` for
   * relative loads.
   */
  function getRequire() {
    if (cachedRequire === void 0) cachedRequire = bindRequire();
    return cachedRequire;
  }
  /**
   * Is `name` a Node built-in module? Resolved from the statically-imported
   * `isBuiltin`, so it works on Node and on ahead-of-time-compiled binaries
   * (Perry), where ambient `require('module')` would lack `isBuiltin`. Returns
   * false in browsers, where the bare `module` import is stubbed away.
   *
   * Single source of truth for "is this a Node builtin?" probes across socket-lib
   * (used by the smol-binding loaders to gate their `node:smol-*` loads).
   */
  function isNodeBuiltin(name) {
    if (
      !require_constants_runtime.IS_NODE ||
      typeof module$1.isBuiltin !== "function"
    )
      return false;
    return (0, module$1.isBuiltin)(name);
  }
  /**
   * Load a built-in module by *computed* specifier through the bound `require`
   * (see getRequire). The specifier is a parameter — never a literal at the call
   * site — so browser bundlers neither walk nor bundle it. Returns undefined
   * where no `require` can be bound.
   *
   * Builtins / bare packages only (dir-independent); for a relative specifier use
   * `requireFrom`. Used by `getNodeModule` for `node:module`, and by the
   * smol-binding loaders for the optional `node:smol-*` native bindings (gated
   * behind `isNodeBuiltin`, true only on socket-btm's smol Node binary).
   */
  function requireBuiltin(specifier) {
    const req = getRequire();
    if (req) return req(specifier);
  }
  /**
   * Load a module by specifier from a CALLER-supplied base (its
   * `import.meta.url`). Use this for RELATIVE specifiers (`./x`, `../y`), whose
   * resolution depends on the caller's directory — `requireBuiltin` binds to this
   * file and would resolve them from `src/node/`. Not cached: the binding is
   * per-caller. Returns undefined where no `require` can be bound.
   */
  function requireFrom(fromUrl, specifier) {
    const req = bindRequire(fromUrl);
    if (req) return req(specifier);
  }
  exports.bindRequire = bindRequire;
  exports.getNodeModule = getNodeModule;
  exports.getRequire = getRequire;
  exports.isNodeBuiltin = isNodeBuiltin;
  exports.requireBuiltin = requireBuiltin;
  exports.requireFrom = requireFrom;
});

var require_detect = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_node_module = require_module();
  /**
   * @file Smol detection + lazy-loader for `node:smol-util`. Two
   *   responsibilities:
   *
   *   1. `isSmol()` — memoized boolean detector for socket-btm's smol Node binary.
   *      Mirrors `isSeaBinary()` from `src/sea.ts`. Probes via
   *      `node:module.isBuiltin('node:smol-util')` since only the smol binary
   *      registers any `node:smol-*` builtins.
   *   2. `getSmolUtil()` — lazy-loader for the `node:smol-util` binding, which
   *      provides native `uncurryThis` and `applyBind` (single V8 dispatch via
   *      `args.Data()` + `v8::Function::Call`, skipping the BoundFunction
   *      adapter
   *
   *   - `Function.prototype.call` trampoline that the JS form `bind.bind(call)(fn)`
   *     hits twice per invocation). ~2x faster on hot uncurried-call sites.
   *     `getSmolUtil()` returns `undefined` on stock Node
   *   - non-Node runtimes. Result is cached across calls; the lazy-loader follows
   *     the same shape as `src/node/fs.ts` etc.
   *
   * @see https://github.com/SocketDev/socket-btm — socket-btm builds
   *   the smol binary that exposes the `node:smol-util` binding.
   */
  /**
   * Cached smol-binary detection result.
   */
  let isSmolCache;
  /**
   * Cached `node:smol-util` binding. `null` = probed and unavailable; `undefined`
   * = not yet probed. JS truthiness collapses both to "no binding" at the call
   * site.
   */
  let smolUtilCache;
  let smolUtilProbed = false;
  /**
   * Returns `node:smol-util` when running on the smol Node binary, otherwise
   * `undefined`. Result is cached across calls.
   */
  function getSmolUtil() {
    if (!smolUtilProbed) {
      smolUtilProbed = true;
      /* c8 ignore start - smol Node binary only. */
      if (require_node_module.isNodeBuiltin("node:smol-util"))
        smolUtilCache = require_node_module.requireBuiltin("node:smol-util");
    }
    return smolUtilCache;
  }
  /**
   * Detect if the current process is running on socket-btm's smol Node binary.
   * Memoized on first call.
   *
   * Defensive across runtimes: returns `false` on stock Node, browsers (no
   * `node:module`), Deno and Bun, whose module resolution differs, and worker
   * threads, each of which has its own builtin table.
   *
   * @example
   *   ;```ts
   *   import { isSmol } from '@socketsecurity/lib/exe/smol/detect'
   *
   *   if (isSmol()) {
   *     // running on the smol binary; native fast paths available
   *   }
   *   ```
   */
  function isSmol() {
    if (isSmolCache === void 0)
      isSmolCache = require_node_module.isNodeBuiltin("node:smol-util");
    return isSmolCache;
  }
  exports.getSmolUtil = getSmolUtil;
  exports.isSmol = isSmol;
});

var require_uncurry = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  /**
   * @file `uncurryThis` and the cluster of helpers built atop it. Mirrors
   *   Node.js's internal/per_context/primordials.js. Every other primordials leaf
   *   depends on `uncurryThis` to expose prototype-method primordials, so this
   *   file must be import-safe before any of them. Smol fast paths
   *   (`node:smol-util`) replace the JS forms when running on socket-btm's smol
   *   Node binary; stock Node and other runtimes fall back to the standard
   *   `bind.bind(call)` shape. **IMPORTANT**: do not destructure on `globalThis`
   *   or `Reflect` here. tsgo has a bug that mis-transpiles destructured exports.
   *   See: https://github.com/SocketDev/socket-packageurl-js/issues/3.
   */
  const smolUtil = require_detect().getSmolUtil();
  const { apply, bind, call } = Function.prototype;
  const uncurryThis = smolUtil?.uncurryThis ?? bind.bind(call);
  const applyBind = smolUtil?.applyBind ?? bind.bind(apply);
  const applyBoundForSafe = applyBind;
  const applySafe =
    smolUtil?.applySafe ??
    ((fn) => {
      const apply2 = applyBoundForSafe(fn);
      return (self, args) => {
        try {
          return apply2(self, args);
        } catch {
          return;
        }
      };
    });
  const bindCallFallback = (fn, thisArg, ...presetArgs) =>
    Function.prototype.bind.apply(fn, [thisArg, ...presetArgs]);
  const bindCall = smolUtil?.bindCall ?? bindCallFallback;
  const weakRefSafe =
    smolUtil?.weakRefSafe ??
    ((target) => {
      try {
        return new WeakRef(target);
      } catch {
        return;
      }
    });
  exports.applyBind = applyBind;
  exports.applySafe = applySafe;
  exports.bindCall = bindCall;
  exports.uncurryThis = uncurryThis;
  exports.weakRefSafe = weakRefSafe;
});

var require_object = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_primordials_uncurry = require_uncurry();
  /**
   * @file Safe references to `Object` static methods and prototype methods. Annex
   *   B legacy accessor methods (`__defineGetter__`, `__lookupGetter__`, etc.)
   *   are exposed alongside the canonical static methods — implementations exist
   *   in V8, SpiderMonkey, and JavaScriptCore even though the spec calls them
   *   "normative optional".
   */
  const ObjectCtor = Object;
  const ObjectAssign = Object.assign;
  const ObjectCreate = Object.create;
  const ObjectDefineProperties = Object.defineProperties;
  const ObjectDefineProperty = Object.defineProperty;
  const ObjectEntries = Object.entries;
  const ObjectFreeze = Object.freeze;
  const ObjectFromEntries = Object.fromEntries;
  const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const ObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
  const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
  const ObjectGetPrototypeOf = Object.getPrototypeOf;
  const ObjectHasOwn = Object.hasOwn;
  const ObjectIs = Object.is;
  const ObjectIsExtensible = Object.isExtensible;
  const ObjectIsFrozen = Object.isFrozen;
  const ObjectIsSealed = Object.isSealed;
  const ObjectKeys = Object.keys;
  const ObjectPreventExtensions = Object.preventExtensions;
  const ObjectSeal = Object.seal;
  const ObjectSetPrototypeOf = Object.setPrototypeOf;
  const ObjectValues = Object.values;
  const ObjectPrototype = Object.prototype;
  const ObjectPrototypeHasOwnProperty = require_primordials_uncurry.uncurryThis(
    Object.prototype.hasOwnProperty,
  );
  const ObjectPrototypeIsPrototypeOf = require_primordials_uncurry.uncurryThis(
    Object.prototype.isPrototypeOf,
  );
  const ObjectPrototypePropertyIsEnumerable =
    require_primordials_uncurry.uncurryThis(
      Object.prototype.propertyIsEnumerable,
    );
  const ObjectPrototypeToString = require_primordials_uncurry.uncurryThis(
    Object.prototype.toString,
  );
  const ObjectPrototypeValueOf = require_primordials_uncurry.uncurryThis(
    Object.prototype.valueOf,
  );
  const objectProto = Object.prototype;
  const ObjectPrototypeDefineGetter = require_primordials_uncurry.uncurryThis(
    objectProto.__defineGetter__,
  );
  const ObjectPrototypeDefineSetter = require_primordials_uncurry.uncurryThis(
    objectProto.__defineSetter__,
  );
  const ObjectPrototypeLookupGetter = require_primordials_uncurry.uncurryThis(
    objectProto.__lookupGetter__,
  );
  const ObjectPrototypeLookupSetter = require_primordials_uncurry.uncurryThis(
    objectProto.__lookupSetter__,
  );
  exports.ObjectAssign = ObjectAssign;
  exports.ObjectCreate = ObjectCreate;
  exports.ObjectCtor = ObjectCtor;
  exports.ObjectDefineProperties = ObjectDefineProperties;
  exports.ObjectDefineProperty = ObjectDefineProperty;
  exports.ObjectEntries = ObjectEntries;
  exports.ObjectFreeze = ObjectFreeze;
  exports.ObjectFromEntries = ObjectFromEntries;
  exports.ObjectGetOwnPropertyDescriptor = ObjectGetOwnPropertyDescriptor;
  exports.ObjectGetOwnPropertyDescriptors = ObjectGetOwnPropertyDescriptors;
  exports.ObjectGetOwnPropertyNames = ObjectGetOwnPropertyNames;
  exports.ObjectGetOwnPropertySymbols = ObjectGetOwnPropertySymbols;
  exports.ObjectGetPrototypeOf = ObjectGetPrototypeOf;
  exports.ObjectHasOwn = ObjectHasOwn;
  exports.ObjectIs = ObjectIs;
  exports.ObjectIsExtensible = ObjectIsExtensible;
  exports.ObjectIsFrozen = ObjectIsFrozen;
  exports.ObjectIsSealed = ObjectIsSealed;
  exports.ObjectKeys = ObjectKeys;
  exports.ObjectPreventExtensions = ObjectPreventExtensions;
  exports.ObjectPrototype = ObjectPrototype;
  exports.ObjectPrototypeDefineGetter = ObjectPrototypeDefineGetter;
  exports.ObjectPrototypeDefineSetter = ObjectPrototypeDefineSetter;
  exports.ObjectPrototypeHasOwnProperty = ObjectPrototypeHasOwnProperty;
  exports.ObjectPrototypeIsPrototypeOf = ObjectPrototypeIsPrototypeOf;
  exports.ObjectPrototypeLookupGetter = ObjectPrototypeLookupGetter;
  exports.ObjectPrototypeLookupSetter = ObjectPrototypeLookupSetter;
  exports.ObjectPrototypePropertyIsEnumerable =
    ObjectPrototypePropertyIsEnumerable;
  exports.ObjectPrototypeToString = ObjectPrototypeToString;
  exports.ObjectPrototypeValueOf = ObjectPrototypeValueOf;
  exports.ObjectSeal = ObjectSeal;
  exports.ObjectSetPrototypeOf = ObjectSetPrototypeOf;
  exports.ObjectValues = ObjectValues;
});

var require_error = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  /**
   * @file Safe references to `Error` and its subclass constructors, plus V8's
   *   stack-trace API. `Error.isError` is ES2025; `captureStackTrace` /
   *   `prepareStackTrace` / `stackTraceLimit` are V8 extensions absent on
   *   JavaScriptCore and SpiderMonkey. Each is typed `Function | undefined` so
   *   non-V8 importers stay safe.
   */
  const ErrorCtor = Error;
  const AggregateErrorCtor = AggregateError;
  const EvalErrorCtor = EvalError;
  const RangeErrorCtor = RangeError;
  const ReferenceErrorCtor = ReferenceError;
  const SyntaxErrorCtor = SyntaxError;
  const TypeErrorCtor = TypeError;
  const URIErrorCtor = URIError;
  const ErrorIsError = Error.isError;
  const ErrorCaptureStackTrace = Error.captureStackTrace;
  const ErrorPrepareStackTrace = Error.prepareStackTrace;
  const stackTraceLimitGetter = (() => {
    const getter = Error.__lookupGetter__?.("stackTraceLimit");
    /* c8 ignore start */
    if (typeof getter === "function") return () => getter.call(Error);
    /* c8 ignore stop */
  })();
  function ErrorStackTraceLimit() {
    /* c8 ignore start - non-V8 fallback path unreachable under test */
    if (stackTraceLimitGetter) return stackTraceLimitGetter();
    return Error.stackTraceLimit;
    /* c8 ignore stop */
  }
  exports.AggregateErrorCtor = AggregateErrorCtor;
  exports.ErrorCaptureStackTrace = ErrorCaptureStackTrace;
  exports.ErrorCtor = ErrorCtor;
  exports.ErrorIsError = ErrorIsError;
  exports.ErrorPrepareStackTrace = ErrorPrepareStackTrace;
  exports.ErrorStackTraceLimit = ErrorStackTraceLimit;
  exports.EvalErrorCtor = EvalErrorCtor;
  exports.RangeErrorCtor = RangeErrorCtor;
  exports.ReferenceErrorCtor = ReferenceErrorCtor;
  exports.SyntaxErrorCtor = SyntaxErrorCtor;
  exports.TypeErrorCtor = TypeErrorCtor;
  exports.URIErrorCtor = URIErrorCtor;
});

var require_primordial = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_node_module = require_module();
  /**
   * @file Lazy-loader for socket-btm's `node:smol-primordial` binding.
   *   `node:smol-primordial` provides V8 Fast API typed implementations of Math.*
   *   and Number.is* primordials, registered with `CFunction::Make()` so TurboFan
   *   inlines them directly into JIT- compiled JS callers. Bypasses the
   *   FunctionCallbackInfo trampoline entirely — ~30-50% gain on hot loops where
   *   V8 doesn't already auto-inline. Returns `undefined` on stock Node +
   *   non-Node runtimes. Result is cached across calls.
   *
   * @internal — used by `src/primordials.ts` to resolve smol-aware
   *   Math.* / Number.is* fast paths. Most callers should use the
   *   standard `primordials` exports, which already route through this
   *   when smol is present.
   *
   * @see https://v8.dev/blog/v8-release-99 — V8 Fast API Calls overview
   */
  let smolPrimordial;
  let smolPrimordialProbed = false;
  /**
   * Returns `node:smol-primordial` when running on the smol Node binary,
   * otherwise `undefined`. Result is cached across calls.
   */
  function getSmolPrimordial() {
    if (!smolPrimordialProbed) {
      smolPrimordialProbed = true;
      /* c8 ignore start - smol Node binary only. */
      if (require_node_module.isNodeBuiltin("node:smol-primordial"))
        smolPrimordial = require_node_module.requireBuiltin(
          "node:smol-primordial",
        );
    }
    return smolPrimordial;
  }
  exports.getSmolPrimordial = getSmolPrimordial;
});

var require_string = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_primordials_uncurry = require_uncurry();
  /**
   * @file Safe references to `String` static methods and prototype methods.
   *   `StringPrototypeCharCodeAt` prefers the smol Fast API binding for ASCII
   *   inputs, which reduces to a single byte load, and translates the `-1` Fast
   *   API sentinel back to `NaN` to preserve spec parity. Two-byte strings fall
   *   back to the uncurried `String.prototype.charCodeAt`.
   *
   *   ## Fast API surface — and why it's small
   *
   *   Mirrors the design rationale from socket-btm's `primordial_binding.cc`
   *   (lines 41-72). The smol Fast API exposes exactly one string op
   *   (`stringCharCodeAt`) because that's the one shape where the C++ trampoline
   *   genuinely beats V8's existing hot path: a single ASCII byte load, no
   *   encoding dispatch, no HandleScope, returns a primitive. String **searches**
   *   (`startsWith` / `endsWith` / `includes` / `indexOf` / `lastIndexOf`) are
   *   intentionally NOT exposed. V8's existing hot path dispatches on encoding
   *   and runs native SIMD memcmp — a Fast API binding would add overhead without
   *   winning. Same for `Map.has` / `Set.has` / `Array.includes`. Fast API also
   *   has a hard constraint: a fast-path function cannot return a new V8 object —
   *   only primitives, Local<Value/Object/Array>, or FastOneByteString. That
   *   rules out anything that produces a new string (`slice`, `substring`,
   *   `toUpperCase`, `concat`, `repeat`, `padStart`/`padEnd`, formatted-number)
   *   from ever being a Fast API win on the return path. Net: the current surface
   *   is approximately the ceiling. Adding more Fast API string ops without a
   *   flamegraph showing the cost is a regression risk, not a perf win. See
   *   `socket-btm/packages/node-smol-builder/additions/source-patched/`
   *   `src/socketsecurity/primordial/primordial_binding.cc:41-72` for the
   *   canonical design statement.
   */
  const smolPrimordial = require_primordial().getSmolPrimordial();
  const StringCtor = String;
  const StringFromCharCode = String.fromCharCode;
  const StringFromCodePoint = String.fromCodePoint;
  const StringRaw = String.raw;
  const StringPrototypeAt = require_primordials_uncurry.uncurryThis(
    String.prototype.at,
  );
  const StringPrototypeCharAt = require_primordials_uncurry.uncurryThis(
    String.prototype.charAt,
  );
  const smolCharCodeAt = smolPrimordial?.stringCharCodeAt;
  /* c8 ignore start - the smol Fast API binding ships only on socket-btm's smol Node binary, so this body cannot run under the stock-Node runner */
  function smolStringCharCodeAt(s, i) {
    const code = smolCharCodeAt(s, i);
    return code === -1 ? NaN : code;
  }
  /* c8 ignore stop */
  const StringPrototypeCharCodeAt = smolCharCodeAt
    ? smolStringCharCodeAt
    : require_primordials_uncurry.uncurryThis(String.prototype.charCodeAt);
  const StringPrototypeCodePointAt = require_primordials_uncurry.uncurryThis(
    String.prototype.codePointAt,
  );
  const StringPrototypeConcat = require_primordials_uncurry.uncurryThis(
    String.prototype.concat,
  );
  const StringPrototypeEndsWith = require_primordials_uncurry.uncurryThis(
    String.prototype.endsWith,
  );
  const StringPrototypeIncludes = require_primordials_uncurry.uncurryThis(
    String.prototype.includes,
  );
  const StringPrototypeIndexOf = require_primordials_uncurry.uncurryThis(
    String.prototype.indexOf,
  );
  const StringPrototypeIsWellFormed =
    smolPrimordial?.stringIsWellFormed ??
    require_primordials_uncurry.uncurryThis(String.prototype.isWellFormed);
  const StringPrototypeLastIndexOf = require_primordials_uncurry.uncurryThis(
    String.prototype.lastIndexOf,
  );
  const StringPrototypeLocaleCompare = require_primordials_uncurry.uncurryThis(
    String.prototype.localeCompare,
  );
  const StringPrototypeMatch = require_primordials_uncurry.uncurryThis(
    String.prototype.match,
  );
  const StringPrototypeMatchAll = require_primordials_uncurry.uncurryThis(
    String.prototype.matchAll,
  );
  const StringPrototypeNormalize = require_primordials_uncurry.uncurryThis(
    String.prototype.normalize,
  );
  const StringPrototypePadEnd = require_primordials_uncurry.uncurryThis(
    String.prototype.padEnd,
  );
  const StringPrototypePadStart = require_primordials_uncurry.uncurryThis(
    String.prototype.padStart,
  );
  const StringPrototypeRepeat = require_primordials_uncurry.uncurryThis(
    String.prototype.repeat,
  );
  const StringPrototypeReplace = require_primordials_uncurry.uncurryThis(
    String.prototype.replace,
  );
  const StringPrototypeReplaceAll = require_primordials_uncurry.uncurryThis(
    String.prototype.replaceAll,
  );
  const StringPrototypeSearch = require_primordials_uncurry.uncurryThis(
    String.prototype.search,
  );
  const StringPrototypeSlice = require_primordials_uncurry.uncurryThis(
    String.prototype.slice,
  );
  const StringPrototypeSplit = require_primordials_uncurry.uncurryThis(
    String.prototype.split,
  );
  const StringPrototypeStartsWith = require_primordials_uncurry.uncurryThis(
    String.prototype.startsWith,
  );
  const StringPrototypeSubstring = require_primordials_uncurry.uncurryThis(
    String.prototype.substring,
  );
  const StringPrototypeToLocaleLowerCase =
    require_primordials_uncurry.uncurryThis(String.prototype.toLocaleLowerCase);
  const StringPrototypeToLocaleUpperCase =
    require_primordials_uncurry.uncurryThis(String.prototype.toLocaleUpperCase);
  const StringPrototypeToLowerCase = require_primordials_uncurry.uncurryThis(
    String.prototype.toLowerCase,
  );
  const StringPrototypeToString = require_primordials_uncurry.uncurryThis(
    String.prototype.toString,
  );
  const StringPrototypeToUpperCase = require_primordials_uncurry.uncurryThis(
    String.prototype.toUpperCase,
  );
  const StringPrototypeToWellFormed = require_primordials_uncurry.uncurryThis(
    String.prototype.toWellFormed,
  );
  const StringPrototypeTrim = require_primordials_uncurry.uncurryThis(
    String.prototype.trim,
  );
  const StringPrototypeTrimEnd = require_primordials_uncurry.uncurryThis(
    String.prototype.trimEnd,
  );
  const StringPrototypeTrimStart = require_primordials_uncurry.uncurryThis(
    String.prototype.trimStart,
  );
  const StringPrototypeValueOf = require_primordials_uncurry.uncurryThis(
    String.prototype.valueOf,
  );
  exports.StringCtor = StringCtor;
  exports.StringFromCharCode = StringFromCharCode;
  exports.StringFromCodePoint = StringFromCodePoint;
  exports.StringPrototypeAt = StringPrototypeAt;
  exports.StringPrototypeCharAt = StringPrototypeCharAt;
  exports.StringPrototypeCharCodeAt = StringPrototypeCharCodeAt;
  exports.StringPrototypeCodePointAt = StringPrototypeCodePointAt;
  exports.StringPrototypeConcat = StringPrototypeConcat;
  exports.StringPrototypeEndsWith = StringPrototypeEndsWith;
  exports.StringPrototypeIncludes = StringPrototypeIncludes;
  exports.StringPrototypeIndexOf = StringPrototypeIndexOf;
  exports.StringPrototypeIsWellFormed = StringPrototypeIsWellFormed;
  exports.StringPrototypeLastIndexOf = StringPrototypeLastIndexOf;
  exports.StringPrototypeLocaleCompare = StringPrototypeLocaleCompare;
  exports.StringPrototypeMatch = StringPrototypeMatch;
  exports.StringPrototypeMatchAll = StringPrototypeMatchAll;
  exports.StringPrototypeNormalize = StringPrototypeNormalize;
  exports.StringPrototypePadEnd = StringPrototypePadEnd;
  exports.StringPrototypePadStart = StringPrototypePadStart;
  exports.StringPrototypeRepeat = StringPrototypeRepeat;
  exports.StringPrototypeReplace = StringPrototypeReplace;
  exports.StringPrototypeReplaceAll = StringPrototypeReplaceAll;
  exports.StringPrototypeSearch = StringPrototypeSearch;
  exports.StringPrototypeSlice = StringPrototypeSlice;
  exports.StringPrototypeSplit = StringPrototypeSplit;
  exports.StringPrototypeStartsWith = StringPrototypeStartsWith;
  exports.StringPrototypeSubstring = StringPrototypeSubstring;
  exports.StringPrototypeToLocaleLowerCase = StringPrototypeToLocaleLowerCase;
  exports.StringPrototypeToLocaleUpperCase = StringPrototypeToLocaleUpperCase;
  exports.StringPrototypeToLowerCase = StringPrototypeToLowerCase;
  exports.StringPrototypeToString = StringPrototypeToString;
  exports.StringPrototypeToUpperCase = StringPrototypeToUpperCase;
  exports.StringPrototypeToWellFormed = StringPrototypeToWellFormed;
  exports.StringPrototypeTrim = StringPrototypeTrim;
  exports.StringPrototypeTrimEnd = StringPrototypeTrimEnd;
  exports.StringPrototypeTrimStart = StringPrototypeTrimStart;
  exports.StringPrototypeValueOf = StringPrototypeValueOf;
  exports.StringRaw = StringRaw;
  exports.smolStringCharCodeAt = smolStringCharCodeAt;
});

var require_predicates = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_primordials_object = require_object();
  const require_primordials_error = require_error();
  const require_primordials_string = require_string();
  /**
   * @file Error type-guard predicates — `isError` (with the `isErrorBuiltin` /
   *   `isErrorShim` building blocks) and the libuv errno-code narrower
   *   `isErrnoException`. Both are cross-realm-safe (they use `[[ErrorData]]`
   *   slot semantics rather than `instanceof Error`).
   */
  /**
   * Reference to the native ES2025 `Error.isError` when the running engine ships
   * it, otherwise `undefined`. Consumes the single primordial snapshot
   * ({@link ErrorIsError}) rather than re-probing the global — one capture point.
   * Exposed separately so tests and callers can detect the fast-path.
   */
  const isErrorBuiltin = require_primordials_error.ErrorIsError;
  /**
   * Narrow a caught value to a Node.js `ErrnoException` — an Error with a `.code`
   * string set by libuv/syscall failures (e.g. `'ENOENT'`, `'EACCES'`, `'EBUSY'`,
   * `'EPERM'`). Cross-realm safe (builds on {@link isError}), and checks that
   * `code` is a string so a merely branded Error without a real errno code
   * returns `false`.
   *
   * @example
   *   try {
   *     await fsPromises.readFile(path)
   *   } catch (e) {
   *     if (isErrnoException(e) && e.code === 'ENOENT') {
   *       // … retry, or return default …
   *     } else {
   *       throw e
   *     }
   *   }
   */
  function isErrnoException(value) {
    if (!isError(value)) return false;
    const code = value.code;
    if (typeof code !== "string" || code.length === 0) return false;
    const first = require_primordials_string.StringPrototypeCharCodeAt(code, 0);
    return first >= 65 && first <= 90;
  }
  /**
   * `Error.isError` fallback shim — the in-language approximation used when the
   * native ES2025 method isn't available.
   *
   * Exported separately so test suites on engines that ship the native method can
   * still exercise the shim branch directly. Consumers should prefer
   * {@link isError}, which picks the native method when present.
   */
  function isErrorShim(value) {
    if (value === null || typeof value !== "object") return false;
    return (
      require_primordials_object.ObjectPrototypeToString(value) ===
      "[object Error]"
    );
  }
  /**
   * Prefer the native ES2025 `Error.isError` when available (exact
   * `[[ErrorData]]` slot check, cross-realm-safe); fall back to
   * {@link isErrorShim} otherwise.
   */
  const isError = isErrorBuiltin ?? isErrorShim;
  exports.isErrnoException = isErrnoException;
  exports.isError = isError;
  exports.isErrorBuiltin = isErrorBuiltin;
  exports.isErrorShim = isErrorShim;
});

var require_map_set = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_primordials_uncurry = require_uncurry();
  const require_primordials_object = require_object();
  const require_primordials_error = require_error();
  /**
   * @file Safe references to `Map`, `Set`, `WeakMap`, `WeakSet`, and `WeakRef`.
   *   Constructors plus uncurried prototype methods. `WeakRef` exposes only its
   *   constructor — there's a separate `weakRefSafe` wrapper in `./uncurry` for
   *   the throws-on-non-Object case.
   */
  const MapCtor = Map;
  const SetCtor = Set;
  const WeakMapCtor = WeakMap;
  const WeakRefCtor = WeakRef;
  const WeakSetCtor = WeakSet;
  const MapPrototypeClear = require_primordials_uncurry.uncurryThis(
    Map.prototype.clear,
  );
  const MapPrototypeDelete = require_primordials_uncurry.uncurryThis(
    Map.prototype.delete,
  );
  const MapPrototypeEntries = require_primordials_uncurry.uncurryThis(
    Map.prototype.entries,
  );
  const MapPrototypeForEach = require_primordials_uncurry.uncurryThis(
    Map.prototype.forEach,
  );
  const MapPrototypeGet = require_primordials_uncurry.uncurryThis(
    Map.prototype.get,
  );
  const MapPrototypeGetOrInsert =
    Map.prototype.getOrInsert === void 0
      ? mapGetOrInsertFallback
      : require_primordials_uncurry.uncurryThis(Map.prototype.getOrInsert);
  const MapPrototypeGetOrInsertComputed =
    Map.prototype.getOrInsertComputed === void 0
      ? mapGetOrInsertComputedFallback
      : require_primordials_uncurry.uncurryThis(
          Map.prototype.getOrInsertComputed,
        );
  const MapPrototypeHas = require_primordials_uncurry.uncurryThis(
    Map.prototype.has,
  );
  const MapPrototypeKeys = require_primordials_uncurry.uncurryThis(
    Map.prototype.keys,
  );
  const MapPrototypeSet = require_primordials_uncurry.uncurryThis(
    Map.prototype.set,
  );
  const MapPrototypeValues = require_primordials_uncurry.uncurryThis(
    Map.prototype.values,
  );
  const SetPrototypeAdd = require_primordials_uncurry.uncurryThis(
    Set.prototype.add,
  );
  const SetPrototypeClear = require_primordials_uncurry.uncurryThis(
    Set.prototype.clear,
  );
  const SetPrototypeDelete = require_primordials_uncurry.uncurryThis(
    Set.prototype.delete,
  );
  const SetPrototypeDifference = require_primordials_uncurry.uncurryThis(
    Set.prototype.difference,
  );
  const SetPrototypeEntries = require_primordials_uncurry.uncurryThis(
    Set.prototype.entries,
  );
  const SetPrototypeForEach = require_primordials_uncurry.uncurryThis(
    Set.prototype.forEach,
  );
  const SetPrototypeHas = require_primordials_uncurry.uncurryThis(
    Set.prototype.has,
  );
  const SetPrototypeIntersection = require_primordials_uncurry.uncurryThis(
    Set.prototype.intersection,
  );
  const SetPrototypeIsDisjointFrom = require_primordials_uncurry.uncurryThis(
    Set.prototype.isDisjointFrom,
  );
  const SetPrototypeIsSubsetOf = require_primordials_uncurry.uncurryThis(
    Set.prototype.isSubsetOf,
  );
  const SetPrototypeIsSupersetOf = require_primordials_uncurry.uncurryThis(
    Set.prototype.isSupersetOf,
  );
  const SetPrototypeKeys = require_primordials_uncurry.uncurryThis(
    Set.prototype.keys,
  );
  const SetPrototypeSymmetricDifference =
    require_primordials_uncurry.uncurryThis(Set.prototype.symmetricDifference);
  const SetPrototypeUnion = require_primordials_uncurry.uncurryThis(
    Set.prototype.union,
  );
  const SetPrototypeValues = require_primordials_uncurry.uncurryThis(
    Set.prototype.values,
  );
  const SetPrototypeSizeGetter = require_primordials_uncurry.uncurryThis(
    require_primordials_object.ObjectGetOwnPropertyDescriptor(
      Set.prototype,
      "size",
    ).get,
  );
  const WeakMapPrototypeDelete = require_primordials_uncurry.uncurryThis(
    WeakMap.prototype.delete,
  );
  const WeakMapPrototypeGet = require_primordials_uncurry.uncurryThis(
    WeakMap.prototype.get,
  );
  const WeakMapPrototypeGetOrInsert =
    WeakMap.prototype.getOrInsert === void 0
      ? weakMapGetOrInsertFallback
      : require_primordials_uncurry.uncurryThis(WeakMap.prototype.getOrInsert);
  const WeakMapPrototypeGetOrInsertComputed =
    WeakMap.prototype.getOrInsertComputed === void 0
      ? weakMapGetOrInsertComputedFallback
      : require_primordials_uncurry.uncurryThis(
          WeakMap.prototype.getOrInsertComputed,
        );
  const WeakMapPrototypeHas = require_primordials_uncurry.uncurryThis(
    WeakMap.prototype.has,
  );
  const WeakMapPrototypeSet = require_primordials_uncurry.uncurryThis(
    WeakMap.prototype.set,
  );
  const WeakSetPrototypeAdd = require_primordials_uncurry.uncurryThis(
    WeakSet.prototype.add,
  );
  const WeakSetPrototypeDelete = require_primordials_uncurry.uncurryThis(
    WeakSet.prototype.delete,
  );
  const WeakSetPrototypeHas = require_primordials_uncurry.uncurryThis(
    WeakSet.prototype.has,
  );
  function mapGetOrInsertComputedFallback(map, key, callbackfn) {
    if (typeof callbackfn !== "function")
      throw new require_primordials_error.TypeErrorCtor(
        `getOrInsertComputed takes a callback. Saw ${typeof callbackfn}, wanted a function computing the value to insert.`,
      );
    if (MapPrototypeHas(map, key)) return MapPrototypeGet(map, key);
    const value = callbackfn(key);
    MapPrototypeSet(map, key, value);
    return value;
  }
  function mapGetOrInsertFallback(map, key, value) {
    if (MapPrototypeHas(map, key)) return MapPrototypeGet(map, key);
    MapPrototypeSet(map, key, value);
    return value;
  }
  function weakMapGetOrInsertComputedFallback(map, key, callbackfn) {
    if (typeof callbackfn !== "function")
      throw new require_primordials_error.TypeErrorCtor(
        `getOrInsertComputed takes a callback. Saw ${typeof callbackfn}, wanted a function computing the value to insert.`,
      );
    if (WeakMapPrototypeHas(map, key)) return WeakMapPrototypeGet(map, key);
    const value = callbackfn(key);
    WeakMapPrototypeSet(map, key, value);
    return value;
  }
  function weakMapGetOrInsertFallback(map, key, value) {
    if (WeakMapPrototypeHas(map, key)) return WeakMapPrototypeGet(map, key);
    WeakMapPrototypeSet(map, key, value);
    return value;
  }
  exports.MapCtor = MapCtor;
  exports.MapPrototypeClear = MapPrototypeClear;
  exports.MapPrototypeDelete = MapPrototypeDelete;
  exports.MapPrototypeEntries = MapPrototypeEntries;
  exports.MapPrototypeForEach = MapPrototypeForEach;
  exports.MapPrototypeGet = MapPrototypeGet;
  exports.MapPrototypeGetOrInsert = MapPrototypeGetOrInsert;
  exports.MapPrototypeGetOrInsertComputed = MapPrototypeGetOrInsertComputed;
  exports.MapPrototypeHas = MapPrototypeHas;
  exports.MapPrototypeKeys = MapPrototypeKeys;
  exports.MapPrototypeSet = MapPrototypeSet;
  exports.MapPrototypeValues = MapPrototypeValues;
  exports.SetCtor = SetCtor;
  exports.SetPrototypeAdd = SetPrototypeAdd;
  exports.SetPrototypeClear = SetPrototypeClear;
  exports.SetPrototypeDelete = SetPrototypeDelete;
  exports.SetPrototypeDifference = SetPrototypeDifference;
  exports.SetPrototypeEntries = SetPrototypeEntries;
  exports.SetPrototypeForEach = SetPrototypeForEach;
  exports.SetPrototypeHas = SetPrototypeHas;
  exports.SetPrototypeIntersection = SetPrototypeIntersection;
  exports.SetPrototypeIsDisjointFrom = SetPrototypeIsDisjointFrom;
  exports.SetPrototypeIsSubsetOf = SetPrototypeIsSubsetOf;
  exports.SetPrototypeIsSupersetOf = SetPrototypeIsSupersetOf;
  exports.SetPrototypeKeys = SetPrototypeKeys;
  exports.SetPrototypeSizeGetter = SetPrototypeSizeGetter;
  exports.SetPrototypeSymmetricDifference = SetPrototypeSymmetricDifference;
  exports.SetPrototypeUnion = SetPrototypeUnion;
  exports.SetPrototypeValues = SetPrototypeValues;
  exports.WeakMapCtor = WeakMapCtor;
  exports.WeakMapPrototypeDelete = WeakMapPrototypeDelete;
  exports.WeakMapPrototypeGet = WeakMapPrototypeGet;
  exports.WeakMapPrototypeGetOrInsert = WeakMapPrototypeGetOrInsert;
  exports.WeakMapPrototypeGetOrInsertComputed =
    WeakMapPrototypeGetOrInsertComputed;
  exports.WeakMapPrototypeHas = WeakMapPrototypeHas;
  exports.WeakMapPrototypeSet = WeakMapPrototypeSet;
  exports.WeakRefCtor = WeakRefCtor;
  exports.WeakSetCtor = WeakSetCtor;
  exports.WeakSetPrototypeAdd = WeakSetPrototypeAdd;
  exports.WeakSetPrototypeDelete = WeakSetPrototypeDelete;
  exports.WeakSetPrototypeHas = WeakSetPrototypeHas;
  exports.mapGetOrInsertComputedFallback = mapGetOrInsertComputedFallback;
  exports.mapGetOrInsertFallback = mapGetOrInsertFallback;
  exports.weakMapGetOrInsertComputedFallback =
    weakMapGetOrInsertComputedFallback;
  exports.weakMapGetOrInsertFallback = weakMapGetOrInsertFallback;
});

var require_pony_cause$1 = /* @__PURE__ */ __commonJSMin$1(
  (exports, module) => {
    const { SetCtor: _p_SetCtor } = require_map_set();
    var __commonJSMin = (cb, mod) => () => (
      mod || (cb((mod = { exports: {} }).exports, mod), (cb = null)),
      mod.exports
    );
    var require_error_with_cause = /* @__PURE__ */ __commonJSMin(
      (exports, module) => {
        module.exports = {
          ErrorWithCause: class ErrorWithCause extends Error {
            /**
             * @param {string} message
             * @param {{ cause?: T }} options
             */
            constructor(message, { cause } = {}) {
              super(message);
              /** @type {string} */
              this.name = ErrorWithCause.name;
              if (cause)
                /** @type {T} */
                this.cause = cause;
              /** @type {string} */
              this.message = message;
            }
          },
        };
      },
    );
    var require_helpers = /* @__PURE__ */ __commonJSMin((exports, module) => {
      const isError =
        typeof Error.isError === "function"
          ? Error.isError
          : (v) =>
              v !== null &&
              typeof v === "object" &&
              Object.prototype.toString.call(v) === "[object Error]";
      /**
       * @template {Error} T
       * @param {unknown} err
       * @param {new(...args: any[]) => T} reference
       * @returns {T|undefined}
       */
      const findCauseByReference = (err, reference) => {
        if (!err || !reference) return;
        if (!isError(err)) return;
        if (!(reference.prototype instanceof Error) && reference !== Error)
          return;
        /**
         * Ensures we don't go circular
         *
         * @type {Set<Error>}
         */
        const seen = /* @__PURE__ */ new _p_SetCtor();
        /** @type {Error|undefined} */
        let currentErr = err;
        while (currentErr && !seen.has(currentErr)) {
          seen.add(currentErr);
          if (currentErr instanceof reference) return currentErr;
          currentErr = getErrorCause(currentErr);
        }
      };
      /**
       * @param {Error|{ cause?: unknown|(()=>err)}} err
       * @returns {Error|undefined}
       */
      const getErrorCause = (err) => {
        if (!err || typeof err !== "object" || !("cause" in err)) return;
        if (typeof err.cause === "function") {
          const causeResult = err.cause();
          return isError(causeResult) ? causeResult : void 0;
        } else return isError(err.cause) ? err.cause : void 0;
      };
      /**
       * Internal method that keeps a track of which error we have already added, to avoid circular recursion
       *
       * @private
       * @param {Error} err
       * @param {Set<Error>} seen
       * @returns {string}
       */
      const _stackWithCauses = (err, seen) => {
        if (!isError(err)) return "";
        const stack = err.stack || "";
        if (seen.has(err)) return stack + "\ncauses have become circular...";
        const cause = getErrorCause(err);
        if (cause) {
          seen.add(err);
          return stack + "\ncaused by: " + _stackWithCauses(cause, seen);
        } else return stack;
      };
      /**
       * @param {Error} err
       * @returns {string}
       */
      const stackWithCauses = (err) =>
        _stackWithCauses(err, /* @__PURE__ */ new _p_SetCtor());
      /**
       * Internal method that keeps a track of which error we have already added, to avoid circular recursion
       *
       * @private
       * @param {Error} err
       * @param {Set<Error>} seen
       * @param {boolean} [skip]
       * @returns {string}
       */
      const _messageWithCauses = (err, seen, skip) => {
        if (!isError(err)) return "";
        const message = skip ? "" : err.message || "";
        if (seen.has(err)) return message + ": ...";
        const cause = getErrorCause(err);
        if (cause) {
          seen.add(err);
          const skipIfVErrorStyleCause =
            "cause" in err && typeof err.cause === "function";
          return (
            message +
            (skipIfVErrorStyleCause ? "" : ": ") +
            _messageWithCauses(cause, seen, skipIfVErrorStyleCause)
          );
        } else return message;
      };
      /**
       * @param {Error} err
       * @returns {string}
       */
      const messageWithCauses = (err) =>
        _messageWithCauses(err, /* @__PURE__ */ new _p_SetCtor());
      module.exports = {
        findCauseByReference,
        getErrorCause,
        stackWithCauses,
        messageWithCauses,
      };
    });
    var require_pony_cause = /* @__PURE__ */ __commonJSMin(
      (exports, module) => {
        const { ErrorWithCause } = require_error_with_cause();
        const {
          findCauseByReference,
          getErrorCause,
          messageWithCauses,
          stackWithCauses,
        } = require_helpers();
        module.exports = {
          ErrorWithCause,
          findCauseByReference,
          getErrorCause,
          stackWithCauses,
          messageWithCauses,
        };
      },
    );
    module.exports = require_pony_cause();
  },
);

var require_message = /* @__PURE__ */ __commonJSMin$1((exports) => {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const require_constants_sentinels = require_sentinels();
  const require_errors_predicates = require_predicates();
  let src_external_pony_cause_js = require_pony_cause$1();
  /**
   * @file Human-readable error-message extractor. `errorMessage` walks the
   *   `cause` chain via pony-cause's `messageWithCauses` for Errors and falls
   *   back to the shared `UNKNOWN_ERROR` sentinel for everything else.
   *   `messageWithCauses` and `UNKNOWN_ERROR` are re-exported for callers that
   *   need them directly.
   */
  /**
   * Extract a human-readable message from any caught value.
   *
   * Walks the `cause` chain for Errors (via {@link messageWithCauses}); coerces
   * primitives and objects to string; returns {@link UNKNOWN_ERROR} for `null`,
   * `undefined`, empty strings, `[object Object]`, or Errors with no message.
   *
   * @example
   *   try {
   *     await readConfig(path)
   *   } catch (e) {
   *     throw new ErrorCtor(`Failed to read ${path}: ${errorMessage(e)}`, {
   *       cause: e,
   *     })
   *   }
   */
  function errorMessage(value) {
    if (require_errors_predicates.isError(value))
      return (
        (0, src_external_pony_cause_js.messageWithCauses)(value) ||
        "Unknown error"
      );
    if (value === null || value === void 0)
      return require_constants_sentinels.UNKNOWN_ERROR;
    const s = String(value);
    if (s === "" || s === "[object Object]")
      return require_constants_sentinels.UNKNOWN_ERROR;
    return s;
  }
  exports.UNKNOWN_ERROR = require_constants_sentinels.UNKNOWN_ERROR;
  exports.errorMessage = errorMessage;
  exports.messageWithCauses = src_external_pony_cause_js.messageWithCauses;
});

var import_message = require_message();
const DISTRUSTED_CA_SPKI_SHA256 = [
  "8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782",
  "bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3",
  "c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9",
];
const DISTRUSTED_SPKI_SHA256 = new Set(DISTRUSTED_CA_SPKI_SHA256);
const CERTIFICATE_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----/;
function extractCertificatePems(body, options) {
  const config = {
    __proto__: null,
    ...options,
  };
  if (PRIVATE_KEY_PATTERN.test(body))
    throw new Error(
      "TLS trust input contains private key material; provide public CA certificates only.",
    );
  const certificates = body.match(CERTIFICATE_PATTERN) ?? [];
  if (
    body
      .replace(CERTIFICATE_PATTERN, "")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .join("\n")
      .trim()
  )
    throw new Error(
      "TLS trust input contains data outside PEM certificates; provide a public CA PEM bundle.",
    );
  if (!certificates.length) {
    if (config.requireNonEmpty === false && !body.trim()) return [];
    throw new Error(
      "TLS trust input has no PEM CA certificates; provide a valid public CA bundle.",
    );
  }
  return certificates;
}
function parseTlsCertificate(pem, options) {
  const config = {
    __proto__: null,
    ...options,
  };
  let certificate;
  try {
    certificate = new crypto.X509Certificate(pem);
  } catch {
    throw new Error(
      "TLS trust input contains a malformed certificate; provide a valid public CA PEM bundle.",
    );
  }
  const spki = certificate.publicKey.export({
    type: "spki",
    format: "der",
  });
  const fingerprint = crypto.createHash("sha256").update(spki).digest("hex");
  if (DISTRUSTED_SPKI_SHA256.has(fingerprint))
    return { rejectedFingerprint: fingerprint };
  if (!certificate.ca) {
    if (config.skipNonCa) return {};
    throw new Error(
      "TLS trust input contains a non-CA certificate; provide CA certificates only.",
    );
  }
  return { certificate };
}
function filterTlsCertificates(body, options = {}) {
  const pems = extractCertificatePems(body, options);
  if (!pems.length)
    return {
      pem: "",
      certificates: [],
      rejectedFingerprints: [],
    };
  const accepted = [];
  const rejectedFingerprints = [];
  const seen = /* @__PURE__ */ new Set();
  for (const pem of pems) {
    const parsed = parseTlsCertificate(pem, { skipNonCa: options.skipNonCa });
    if (parsed.rejectedFingerprint) {
      rejectedFingerprints.push(parsed.rejectedFingerprint);
      continue;
    }
    if (!parsed.certificate) continue;
    const certificateFingerprint = crypto
      .createHash("sha256")
      .update(parsed.certificate.raw)
      .digest("hex");
    if (!seen.has(certificateFingerprint)) {
      seen.add(certificateFingerprint);
      accepted.push(pem.trim());
    }
  }
  if (!accepted.length && options.requireNonEmpty !== false)
    throw new Error(
      "TLS trust input has no trusted CA certificates after policy filtering.",
    );
  return {
    pem: accepted.length ? `${accepted.join("\n")}\n` : "",
    certificates: accepted,
    rejectedFingerprints,
  };
}
function optionTokens(value) {
  if (!value) return [];
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const character of value)
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") escaped = true;
    else if (quote) {
      if (character === quote) quote = "";
      else token += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else token += character;
  if (token) tokens.push(token);
  return tokens;
}
function inspectNodeOptions(args) {
  const conflicts = [];
  const errors = [];
  const conflictingFlags = args.filter((argument) => {
    return /^--(?:no[-_]use[-_]openssl[-_]ca|use[-_]bundled[-_]ca|use[-_]system[-_]ca)(?:=|$)/.test(
      argument,
    );
  });
  if (conflictingFlags.length) {
    conflicts.push(...conflictingFlags);
    errors.push(
      `Node TLS startup flags conflict with the filtered CA policy: ${conflictingFlags.join(", ")}.`,
    );
  }
  if (!args.some((argument) => /^--use[-_]openssl[-_]ca$/.test(argument)))
    errors.push("Node startup options must include --use-openssl-ca.");
  const rejectUnauthorizedIndex = args.findIndex((argument) =>
    /^--tls-reject[-_]unauthorized(?:=|$)/.test(argument),
  );
  const rejectUnauthorizedFlag = args[rejectUnauthorizedIndex];
  if (
    rejectUnauthorizedIndex >= 0 &&
    rejectUnauthorizedFlag !== void 0 &&
    (/^--tls-reject[-_]unauthorized=0$/.test(rejectUnauthorizedFlag) ||
      args[rejectUnauthorizedIndex + 1] === "0")
  ) {
    conflicts.push(rejectUnauthorizedFlag);
    errors.push("Node startup options disable TLS certificate checks.");
  }
  return {
    conflicts,
    errors,
  };
}
function inspectVerificationEnvironment(env) {
  const conflicts = [];
  const errors = [];
  if (env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0") {
    conflicts.push("NODE_TLS_REJECT_UNAUTHORIZED=0");
    errors.push(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks.",
    );
  }
  if (env["NODE_USE_SYSTEM_CA"] === "1") {
    conflicts.push("NODE_USE_SYSTEM_CA=1");
    errors.push(
      "NODE_USE_SYSTEM_CA=1 adds system roots outside the filtered CA bundle.",
    );
  }
  const gitVerify = env["GIT_SSL_NO_VERIFY"];
  if (gitVerify !== void 0 && !/^(?:0|false|no|off)$/i.test(gitVerify.trim())) {
    conflicts.push("GIT_SSL_NO_VERIFY disables certificate checks");
    errors.push("GIT_SSL_NO_VERIFY disables TLS certificate checks.");
  }
  if (/^(?:0|false)$/i.test(env["CARGO_HTTP_SSL_VERIFY"]?.trim() ?? "")) {
    conflicts.push("CARGO_HTTP_SSL_VERIFY disables certificate checks");
    errors.push("CARGO_HTTP_SSL_VERIFY disables TLS certificate checks.");
  }
  if (env["UV_INSECURE_HOST"] !== void 0) {
    conflicts.push("UV_INSECURE_HOST disables certificate checks for a host");
    errors.push("UV_INSECURE_HOST bypasses TLS verification for a host.");
  }
  return {
    conflicts,
    errors,
  };
}
function inspectCertificateDirectory(env, controlledSslCertDir) {
  const conflicts = [];
  const errors = [];
  const warnings = [];
  const sslCertDir = env["SSL_CERT_DIR"];
  if (!sslCertDir)
    errors.push(
      "SSL_CERT_DIR must point to the managed empty certificate directory.",
    );
  else if (controlledSslCertDir && sslCertDir !== controlledSslCertDir) {
    conflicts.push("SSL_CERT_DIR is not the managed empty directory");
    errors.push(
      "SSL_CERT_DIR does not point to the managed empty certificate directory.",
    );
  } else if (!controlledSslCertDir) {
    conflicts.push("SSL_CERT_DIR is not verified empty");
    warnings.push(
      "SSL_CERT_DIR requires validation as an empty certificate directory.",
    );
  }
  return {
    conflicts,
    errors,
    warnings,
  };
}
function inspectTlsEnvironment(env, options = {}) {
  const config = {
    __proto__: null,
    ...options,
  };
  const parts = [
    inspectNodeOptions([
      ...optionTokens(env["NODE_OPTIONS"]),
      ...(config.execArgv ?? []),
    ]),
    inspectVerificationEnvironment(env),
  ];
  const conflicts = parts.flatMap((part) => part.conflicts);
  const errors = parts.flatMap((part) => part.errors);
  const directory = inspectCertificateDirectory(
    env,
    config.controlledSslCertDir,
  );
  conflicts.push(...directory.conflicts);
  errors.push(...directory.errors);
  const warnings = [...directory.warnings];
  if (config.platform === "win32")
    warnings.push(
      "Windows TLS trust persistence needs runtime-specific verification before it can be reported as enforced.",
    );
  return {
    ok: errors.length === 0 && conflicts.length === 0,
    conflicts,
    errors,
    warnings,
  };
}

/**
 * @file Dependency-free reads of platform CAs under their original environment.
 */
const execFileAsync = promisify(execFile);
const SYSTEM_CA_KEYS = ["SSL_CERT_FILE", "SSL_CERT_DIR"];
function captureTlsPlatformEnvironment(env) {
  return {
    SSL_CERT_FILE: env["SSL_CERT_FILE"] ?? null,
    SSL_CERT_DIR: env["SSL_CERT_DIR"] ?? null,
  };
}
async function readTlsPlatformRoots(kind, options = {}) {
  const { environment } = options;
  if (kind === "bundled" || !environment)
    return getCACertificates(kind).join("\n");
  const env = { ...process$1.env };
  for (const key of SYSTEM_CA_KEYS) {
    const value = environment[key];
    if (value === null) delete env[key];
    else if (typeof value === "string") env[key] = value;
    else
      throw new Error(
        "Original platform CA environment is invalid; rerun TLS trust setup.",
      );
  }
  return (
    await execFileAsync(
      process$1.execPath,
      [
        "--input-type=module",
        "--eval",
        "import { getCACertificates } from 'node:tls'; process.stdout.write(getCACertificates('system').join('\\n'));",
      ],
      {
        env,
        encoding: "utf8",
        timeout: 1e4,
        maxBuffer: 4194304,
      },
    )
  ).stdout;
}

/**
 * @file Dependency-free bounded public CA file reads for the setup action.
 */
const MAX_CA_BYTES = 4194304;
async function readTlsBootstrapCaFile(file, optional = false) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (
      optional &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw new Error(`TLS trust source is unreadable: ${file}`);
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`TLS trust source is not a regular file: ${file}`);
    const bytes = Buffer.alloc(4194305);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_CA_BYTES)
      throw new Error(`TLS trust source exceeds 4 MiB: ${file}`);
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}
async function validateTlsBootstrapSources(sources) {
  for (const source of sources) {
    if (source.key.startsWith("node-")) {
      const kind = source.key.slice(5);
      if (kind === "system" && !source.environment)
        throw new Error(
          "Original system CA environment is missing; rerun the setup action.",
        );
      const current = filterTlsCertificates(
        await readTlsPlatformRoots(kind, { environment: source.environment }),
        {
          requireNonEmpty: false,
          skipNonCa: true,
        },
      ).pem;
      if (
        crypto.createHash("sha256").update(current).digest("hex") !==
        source.sha256
      )
        throw new Error(
          "Node platform CA trust changed; rerun the setup action.",
        );
      continue;
    }
    const current = await readTlsBootstrapCaFile(
      source.path,
      source.sha256 === "missing",
    );
    if (
      source.sha256 === "missing"
        ? current !== void 0
        : current === void 0 ||
          crypto.createHash("sha256").update(current).digest("hex") !==
            source.sha256
    )
      throw new Error(
        `TLS trust input changed: ${source.path}; rerun the setup action.`,
      );
  }
}

const TLS_CA_INPUT_KEYS = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "GIT_PROXY_SSL_CAINFO",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "CARGO_HTTP_PROXY_CAINFO",
  "SSL_CERT_DIR",
  "GIT_SSL_CAPATH",
  "SFW_CA_CERT_PATH",
];
const TLS_CA_FILE_KEYS = Object.freeze(
  TLS_CA_INPUT_KEYS.filter(
    (key) => key !== "SSL_CERT_DIR" && key !== "GIT_SSL_CAPATH",
  ),
);
const TLS_CA_SOURCE_KEYS = Object.freeze(
  TLS_CA_FILE_KEYS.filter((key) => key !== "SFW_CA_CERT_PATH"),
);
const TLS_SFW_BUNDLE_KEYS = Object.freeze(
  TLS_CA_SOURCE_KEYS.filter(
    (key) =>
      key === "SSL_CERT_FILE" ||
      key === "GIT_SSL_CAINFO" ||
      key === "GIT_PROXY_SSL_CAINFO" ||
      key === "CARGO_HTTP_CAINFO",
  ),
);
const TLS_MAX_CA_BYTES = 4194304;
const TLS_TRUST_DIRECTORY_NAME = "fleet-tls-trust";
const TLS_TRUST_DISABLED_CA_DIRECTORY_NAME = "disabled-ca-dir";
const TLS_TRUST_STATE_NAME = "state.json";
const TLS_TRUST_BASH_ENV_NAME = "bash-env";
const TLS_TRUST_HELPER_NAME = "tls-trust-bootstrap.generated.mjs";
const TLS_RUNTIME_DIRECTORY_PREFIX = "fleet-tls-runtime-";
function getTlsTrustRootPath(tempDirectory) {
  return path.join(tempDirectory, TLS_TRUST_DIRECTORY_NAME);
}
function getDefaultSfwCaCertificatePath(homeDirectory) {
  return path.join(homeDirectory, ".socket", "sfw", "ca.crt");
}
function getTlsTrustDisabledCaDirectoryPath(directory) {
  return path.join(directory, TLS_TRUST_DISABLED_CA_DIRECTORY_NAME);
}
function getTlsTrustStatePath(directory) {
  return path.join(directory, TLS_TRUST_STATE_NAME);
}
function getTlsTrustBashEnvPath(directory) {
  return path.join(directory, TLS_TRUST_BASH_ENV_NAME);
}
function getTlsTrustHelperPath(directory) {
  return path.join(directory, TLS_TRUST_HELPER_NAME);
}
function getTlsTrustBundlePath(directory, key, options = {}) {
  const { sslCertFileName = "ca-bundle.pem" } = options;
  const name =
    key === "SSL_CERT_FILE"
      ? sslCertFileName
      : `${key.toLowerCase().replaceAll("_", "-")}.pem`;
  return path.join(directory, name);
}
function getTlsRuntimeDirectoryPrefix(directory) {
  return path.join(directory, TLS_RUNTIME_DIRECTORY_PREFIX);
}

/**
 * @file Build independently filtered bundles for each configured CA source.
 */
const CA_SOURCE_KEYS = TLS_CA_SOURCE_KEYS;
async function readTlsTrustFile(file, options = {}) {
  const config = {
    __proto__: null,
    optional: false,
    ...options,
  };
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (
      config.optional &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw new Error(`TLS trust source is unreadable: ${file}`);
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`TLS trust source is not a regular file: ${file}`);
    const buffer = Buffer.alloc(TLS_MAX_CA_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > 4194304)
      throw new Error(`TLS trust source exceeds 4 MiB: ${file}`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function digest$1(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function savedInput(name, state) {
  return state?.sources.find(
    (source) => source.kind === "file" && source.name === name,
  )?.path;
}
function inputPath(name, env, state, trustDirectory) {
  const current = env[name];
  if (current === state?.bundlePaths[name]) return savedInput(name, state);
  if (current) {
    if (
      path
        .resolve(current)
        .startsWith(`${path.resolve(trustDirectory)}${path.sep}`)
    )
      throw new Error(
        `Managed TLS output has no valid source metadata: ${current}`,
      );
    return current;
  }
}
async function loadSource(name, file, options = {}) {
  const config = {
    __proto__: null,
    optional: false,
    ...options,
  };
  let body;
  try {
    body = await readTlsTrustFile(file, config);
    if (body === void 0)
      return {
        pem: "",
        source: {
          kind: "file",
          name,
          path: file,
          sha256: "missing",
        },
        rejected: [],
      };
  } catch (error) {
    if (
      config.optional &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {
        pem: "",
        source: {
          kind: "file",
          name,
          path: file,
          sha256: "missing",
        },
        rejected: [],
      };
    throw error;
  }
  const filtered = filterTlsCertificates(body);
  return {
    pem: filtered.pem,
    source: {
      kind: "file",
      name,
      path: file,
      sha256: digest$1(body),
    },
    rejected: filtered.rejectedFingerprints,
  };
}
async function loadPlatformRoots(environment) {
  const pem = [];
  const sources = [];
  const rejected = [];
  const rootKinds = ["bundled", "system"];
  for (let index = 0; index < rootKinds.length; index += 1) {
    const name = rootKinds[index];
    const body = await readTlsPlatformRoots(name, {
      environment: name === "system" ? environment : void 0,
    });
    const filtered = filterTlsCertificates(body, {
      requireNonEmpty: false,
      skipNonCa: true,
    });
    if (filtered.pem) {
      pem.push(filtered.pem);
      rejected.push(...filtered.rejectedFingerprints);
    }
    sources.push({
      kind: "node-ca",
      name,
      ...(name === "system" ? { environment } : {}),
      sha256: digest$1(filtered.pem),
    });
  }
  return {
    pem: pem.join("\n"),
    sources,
    rejected,
  };
}
async function buildTlsBundles(config) {
  const { env, homeDir, state, trustDirectory } = config;
  const platformEnvironment =
    state?.sources.find(
      (source) => source.kind === "node-ca" && source.name === "system",
    )?.environment ?? captureTlsPlatformEnvironment(env);
  const sfw = await loadSource(
    "SFW_CA_CERT_PATH",
    env["SFW_CA_CERT_PATH"] ?? getDefaultSfwCaCertificatePath(homeDir),
    { optional: !env["SFW_CA_CERT_PATH"] },
  );
  const sources = sfw.source ? [sfw.source] : [];
  const rejected = [...sfw.rejected];
  const bundlePaths = {
    SSL_CERT_FILE: getTlsTrustBundlePath(trustDirectory, "SSL_CERT_FILE"),
  };
  const bundles = Object.create(null);
  const append = (name, pem) => {
    const filtered = filterTlsCertificates(
      [pem, sfw.pem].filter(Boolean).join("\n"),
    );
    bundles[name] = filtered.pem;
    rejected.push(...filtered.rejectedFingerprints);
  };
  const sslFile = inputPath("SSL_CERT_FILE", env, state, trustDirectory);
  if (sslFile) {
    const source = await loadSource("SSL_CERT_FILE", sslFile, {
      optional: false,
    });
    sources.push(source.source);
    rejected.push(...source.rejected);
    append("SSL_CERT_FILE", source.pem);
  } else {
    const platform = await loadPlatformRoots(platformEnvironment);
    sources.push(...platform.sources);
    rejected.push(...platform.rejected);
    append("SSL_CERT_FILE", platform.pem);
  }
  const extraCaKeys = CA_SOURCE_KEYS.slice(1);
  for (let index = 0; index < extraCaKeys.length; index += 1) {
    const name = extraCaKeys[index];
    const file = inputPath(name, env, state, trustDirectory);
    if (file) {
      const source = await loadSource(name, file, { optional: false });
      sources.push(source.source);
      rejected.push(...source.rejected);
      bundlePaths[name] = getTlsTrustBundlePath(trustDirectory, name);
      append(name, source.pem);
    } else {
      bundlePaths[name] = getTlsTrustBundlePath(trustDirectory, name);
      append(name, bundles["SSL_CERT_FILE"]);
    }
  }
  return {
    bundlePaths,
    bundles,
    sources,
    rejected: [...new Set(rejected)],
  };
}

function hasPrivateTlsPermissions(mode, platform = process$1.platform) {
  return platform === "win32" || (mode & 63) === 0;
}

/**
 * @file Dependency-free cleanup for trust files owned by one bootstrap call.
 */
/**
 * @param {string | undefined} directory
 * @param {{
 *   allowedDirectoryRoot?: string | undefined
 *   inheritedDirectory?: string | undefined
 * }} [options]
 *
 * @returns {void}
 */
function cleanupRuntimeTlsTrust(directory, options = {}) {
  const { allowedDirectoryRoot, inheritedDirectory } = options;
  if (!directory || directory === inheritedDirectory) return;
  if (
    realpathSync(path.dirname(directory)) !==
      realpathSync(allowedDirectoryRoot ?? os.tmpdir()) ||
    !/^fleet-tls-runtime-[A-Za-z0-9]+$/.test(path.basename(directory))
  )
    throw new Error("TLS bootstrap cleanup refused an unowned directory.");
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process$1.platform !== "win32" && (info.mode & 63) !== 0)
  )
    throw new Error("TLS bootstrap cleanup requires a private real directory.");
  rmSync(directory, {
    recursive: true,
    force: true,
  });
}

const TLS_RUNTIME_DIRECTORY_KEY = "FLEET_TLS_TRUST_RUNTIME_DIRECTORY";
const TLS_RUNTIME_CA_KEY = "FLEET_TLS_TRUST_RUNTIME_CA_SOURCE";
async function buildRuntimeTlsBundles(caSource, bundlePaths, directory) {
  const ca = filterTlsCertificates(await readTlsTrustFile(caSource));
  if (ca.certificates.length !== 1 || ca.rejectedFingerprints.length)
    throw new Error(
      "Socket Firewall runtime source must contain one allowed CA certificate.",
    );
  return await buildTlsBundles({
    env: {
      ...bundlePaths,
      SFW_CA_CERT_PATH: caSource,
    },
    homeDir: os.homedir(),
    state: void 0,
    trustDirectory: directory,
  });
}
async function createRuntimeTlsTrust(env, bundlePaths, caSource, options = {}) {
  const directory = await mkdtemp(
    getTlsRuntimeDirectoryPrefix(options.directoryRoot ?? os.tmpdir()),
  );
  try {
    const built = await buildRuntimeTlsBundles(
      caSource,
      bundlePaths,
      directory,
    );
    for (const [name, file] of Object.entries(built.bundlePaths))
      await writeFile(file, built.bundles[name], {
        mode: 384,
        flag: "wx",
      });
    return {
      ...env,
      ...built.bundlePaths,
      [TLS_RUNTIME_DIRECTORY_KEY]: directory,
      [TLS_RUNTIME_CA_KEY]: caSource,
    };
  } catch (error) {
    cleanupRuntimeTlsTrust(directory, {
      allowedDirectoryRoot: options.directoryRoot,
    });
    throw error;
  }
}
async function runtimeTlsTrustReady(env, bundlePaths, options = {}) {
  if (!env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"])
    return (
      !env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"] &&
      Object.entries(bundlePaths).every(([key, file]) => env[key] === file)
    );
  return (await reuseRuntimeTlsTrust(env, bundlePaths, options)) !== void 0;
}
async function reuseRuntimeTlsTrust(env, bundlePaths, options = {}) {
  const directory = env[TLS_RUNTIME_DIRECTORY_KEY];
  if (!directory) return;
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !hasPrivateTlsPermissions(info.mode)
    )
      return;
    if (options.allowedDirectoryRoot) {
      const root = path.resolve(options.allowedDirectoryRoot);
      const directoryPath = path.resolve(directory);
      const rootInfo = await lstat(root);
      if (
        !rootInfo.isDirectory() ||
        rootInfo.isSymbolicLink() ||
        !hasPrivateTlsPermissions(rootInfo.mode) ||
        path.dirname(directoryPath) !== root ||
        (await realpath(root)) !== root ||
        (await realpath(directoryPath)) !== directoryPath
      )
        return;
    }
    const caSource = env[TLS_RUNTIME_CA_KEY];
    if (!caSource) return;
    const built = await buildRuntimeTlsBundles(
      caSource,
      bundlePaths,
      directory,
    );
    const runtimeEnv = {
      ...env,
      ...built.bundlePaths,
    };
    const sfwBundlePath = env["SSL_CERT_FILE"];
    const sfwOverlayMatches = Boolean(
      options.allowSfwOverlay &&
      env["SOCKET_SHIM_ACTIVE_PNPM"] === "1" &&
      env["NODE_EXTRA_CA_CERTS"] === caSource &&
      sfwBundlePath &&
      sfwBundlePath !== caSource &&
      !Object.values(bundlePaths).includes(sfwBundlePath) &&
      TLS_SFW_BUNDLE_KEYS.every((key) => env[key] === sfwBundlePath) &&
      Object.keys(built.bundlePaths).every(
        (key) =>
          key === "NODE_EXTRA_CA_CERTS" ||
          TLS_SFW_BUNDLE_KEYS.includes(key) ||
          env[key] === bundlePaths[key] ||
          env[key] === built.bundlePaths[key],
      ),
    );
    for (const [name, file] of Object.entries(built.bundlePaths)) {
      const fileInfo = await lstat(file);
      if (
        !(
          env[name] === file ||
          (sfwOverlayMatches &&
            (name === "NODE_EXTRA_CA_CERTS"
              ? env[name] === caSource
              : TLS_SFW_BUNDLE_KEYS.includes(name) &&
                env[name] === sfwBundlePath))
        ) ||
        !fileInfo.isFile() ||
        fileInfo.isSymbolicLink() ||
        !hasPrivateTlsPermissions(fileInfo.mode) ||
        (await readTlsTrustFile(file)) !== built.bundles[name]
      )
        return;
    }
    return runtimeEnv;
  } catch {
    return;
  }
}

const SFW_BUNDLE_KEYS = TLS_SFW_BUNDLE_KEYS;
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function sfwTlsBashEnvContents(helperPath) {
  return [
    `if ! FLEET_TLS_TRUST_EXPORTS="$(${`${shellQuote(process$1.execPath)} ${shellQuote(helperPath)} --shell`})"; then`,
    "  exit 1",
    "fi",
    'eval "$FLEET_TLS_TRUST_EXPORTS"',
    "unset FLEET_TLS_TRUST_EXPORTS",
    "",
  ].join("\n");
}
async function sfwTlsRuntimeDirectoryRoot(env) {
  const runnerTemp = env["RUNNER_TEMP"];
  if (!runnerTemp || !path.isAbsolute(runnerTemp))
    throw new Error("Socket Firewall requires an absolute RUNNER_TEMP path.");
  const runnerPath = path.resolve(runnerTemp);
  const runnerInfo = await lstat(runnerPath);
  if (
    !runnerInfo.isDirectory() ||
    runnerInfo.isSymbolicLink() ||
    (await realpath(runnerPath)) !== runnerPath
  )
    throw new Error("Socket Firewall RUNNER_TEMP is not a real directory.");
  const root = getTlsTrustRootPath(runnerPath);
  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(rootInfo.mode) ||
    (await realpath(root)) !== root
  )
    throw new Error("Socket Firewall TLS state directory is not private.");
  return root;
}
function validateSfwTlsRuntimeMarkerPair(env) {
  if (
    Boolean(env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"]) !==
    Boolean(env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"])
  )
    throw new Error("TLS runtime trust markers are incomplete; rerun setup.");
}
function sfwTlsEnvironmentLines(config) {
  const values = {
    ...Object.fromEntries(
      CA_SOURCE_KEYS.map((key) => [
        key,
        config.bash
          ? (config.env[key] ?? config.bundlePaths[key])
          : config.bundlePaths[key],
      ]),
    ),
    SSL_CERT_DIR: config.emptyDirectoryPath,
    GIT_SSL_CAPATH: config.emptyDirectoryPath,
    ...(config.nodeOptions ? { NODE_OPTIONS: config.nodeOptions } : {}),
    BASH_ENV: config.bashEnvPath,
    FLEET_TLS_TRUST_STATE: config.statePath,
    [TLS_RUNTIME_DIRECTORY_KEY]:
      config.env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"] ?? "",
    [TLS_RUNTIME_CA_KEY]: config.env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"] ?? "",
    ...(config.bash && config.env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"]
      ? {
          [TLS_RUNTIME_DIRECTORY_KEY]: config.env[TLS_RUNTIME_DIRECTORY_KEY],
          [TLS_RUNTIME_CA_KEY]: config.env[TLS_RUNTIME_CA_KEY],
        }
      : {}),
  };
  return Object.entries(values).map(([key, value]) =>
    config.bash ? `export ${key}=${shellQuote(value)}` : `${key}=${value}`,
  );
}
async function resolveSfwTlsOverlay(
  env,
  bundlePaths,
  emptyDirectoryPath,
  runtimeDirectoryRoot,
) {
  if (env["SOCKET_SHIM_ACTIVE_PNPM"] !== "1") return env;
  const source = env["NODE_EXTRA_CA_CERTS"];
  if (
    !env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"] &&
    env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"]
  )
    throw new Error(
      "Socket Firewall runtime trust markers are incomplete; restart the wrapped command.",
    );
  const runtimeEnv = env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"]
    ? await reuseRuntimeTlsTrust(env, bundlePaths, {
        allowSfwOverlay: true,
        allowedDirectoryRoot: runtimeDirectoryRoot,
      })
    : void 0;
  if (env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"] && !runtimeEnv)
    throw new Error(
      "Socket Firewall runtime trust changed; restart the wrapped command.",
    );
  if (
    !env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"] &&
    !env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"] &&
    CA_SOURCE_KEYS.every((key) => env[key] === bundlePaths[key]) &&
    env["SSL_CERT_DIR"] === emptyDirectoryPath &&
    env["GIT_SSL_CAPATH"] === emptyDirectoryPath
  )
    return env;
  if (!source)
    throw new Error(
      "Socket Firewall CA source is missing; restart the wrapped command.",
    );
  const runtimeCaSource = env[TLS_RUNTIME_CA_KEY];
  if (
    Boolean(
      runtimeEnv &&
      source === runtimeEnv["NODE_EXTRA_CA_CERTS"] &&
      CA_SOURCE_KEYS.every((key) => env[key] === runtimeEnv[key]),
    )
  )
    return runtimeEnv;
  if (
    Object.values(bundlePaths).includes(source) ||
    (runtimeCaSource && source !== runtimeCaSource)
  )
    throw new Error(
      "Socket Firewall CA source changed after runtime trust setup; restart the wrapped command.",
    );
  const sfwBundle = env["SSL_CERT_FILE"];
  if (
    !sfwBundle ||
    sfwBundle === source ||
    Object.values(bundlePaths).includes(sfwBundle) ||
    SFW_BUNDLE_KEYS.some((key) => env[key] !== sfwBundle)
  )
    throw new Error(
      "Socket Firewall CA bundle does not match its filtered source; restart the wrapped command.",
    );
  for (const key of CA_SOURCE_KEYS) {
    if (key !== "NODE_EXTRA_CA_CERTS" && !SFW_BUNDLE_KEYS.includes(key)) {
      if (env[key] !== bundlePaths[key] && env[key] !== runtimeEnv?.[key])
        throw new Error(
          `${key} changed during Socket Firewall wrapping; restart the wrapped command.`,
        );
    }
    if (!bundlePaths[key])
      throw new Error(`TLS state is missing ${key}; rerun the setup action.`);
  }
  await readTlsTrustFile(sfwBundle);
  if (
    env["SSL_CERT_DIR"] !== emptyDirectoryPath ||
    env["GIT_SSL_CAPATH"] !== emptyDirectoryPath
  )
    throw new Error(
      "TLS CA directories changed during Socket Firewall wrapping; restart the wrapped command.",
    );
  const inspectionEnv = {
    ...env,
    NODE_EXTRA_CA_CERTS: bundlePaths["NODE_EXTRA_CA_CERTS"],
    ...Object.fromEntries(
      SFW_BUNDLE_KEYS.map((key) => [key, bundlePaths[key]]),
    ),
  };
  const inspection = inspectTlsEnvironment(inspectionEnv, {
    platform: process$1.platform,
    execArgv: process$1.execArgv,
    controlledSslCertDir: emptyDirectoryPath,
  });
  if (!inspection.ok)
    throw new Error([...inspection.conflicts, ...inspection.errors].join(" "));
  if (runtimeEnv) return runtimeEnv;
  return await createRuntimeTlsTrust(env, bundlePaths, source, {
    directoryRoot: runtimeDirectoryRoot,
  });
}

const README_NAME = "README.md";
const README_CONTENTS = [
  "# Disabled CA directory",
  "",
  "Set `SSL_CERT_DIR` and `GIT_SSL_CAPATH` to this directory to disable",
  "CA-directory lookup. TLS clients use filtered bundles from file-based settings.",
  "",
  "Keep this README as the only file in the directory. Setup checks its contents.",
  "",
].join("\n");
async function ensureTlsTrustDisabledCaDirectory(directory) {
  await ensureRealDirectory(directory);
  await chmod(directory, 448);
  if ((await readdir(directory)).some((entry) => entry !== README_NAME))
    throw new Error(
      "Managed disabled CA directory contains unexpected files; inspect it before retrying.",
    );
  const readmePath = path.join(directory, README_NAME);
  try {
    const readmeInfo = await lstat(readmePath);
    if (
      !readmeInfo.isFile() ||
      readmeInfo.isSymbolicLink() ||
      !hasPrivateTlsPermissions(readmeInfo.mode) ||
      (await readFile(readmePath, "utf8")) !== README_CONTENTS
    )
      throw new Error(
        "Managed disabled CA directory README is unsafe or modified; inspect it before retrying.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    await writeFile(readmePath, README_CONTENTS, {
      flag: "wx",
      mode: 384,
    });
  }
}
async function ensureRealDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Managed disabled CA path is not a directory; inspect it before retrying.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    await mkdir(directory, {
      recursive: true,
      mode: 448,
    });
  }
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(
      "Managed disabled CA path is not a directory; inspect it before retrying.",
    );
}
async function isTlsTrustDisabledCaDirectorySafe(directory) {
  try {
    const directoryInfo = await lstat(directory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !hasPrivateTlsPermissions(directoryInfo.mode)
    )
      return false;
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== README_NAME) return false;
    const readmePath = path.join(directory, README_NAME);
    const readmeInfo = await lstat(readmePath);
    return (
      readmeInfo.isFile() &&
      !readmeInfo.isSymbolicLink() &&
      hasPrivateTlsPermissions(readmeInfo.mode) &&
      (await readFile(readmePath, "utf8")) === README_CONTENTS
    );
  } catch {
    return false;
  }
}

/**
 * @file Create and validate the filtered CA inputs used by setup action steps.
 */
const CA_KEYS = TLS_CA_SOURCE_KEYS;
function rootDirectory() {
  return getTlsTrustRootPath(process$1.env["RUNNER_TEMP"] || os.tmpdir());
}
function bashEnvPath() {
  return getTlsTrustBashEnvPath(rootDirectory());
}
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
async function writePrivate(file, contents) {
  const temporary = `${file}.${process$1.pid}.${crypto.randomBytes(6).toString("hex")}`;
  await writeFile(temporary, contents, {
    flag: "wx",
    mode: 384,
  });
  try {
    await chmod(temporary, 384);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
function appendNodeOption(value) {
  const options = value?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!options.includes("--use-openssl-ca")) options.push("--use-openssl-ca");
  return options.join(" ");
}
async function buildBundles() {
  const directory = rootDirectory();
  await mkdir(directory, {
    recursive: true,
    mode: 448,
  });
  await chmod(directory, 448);
  const emptyDirectoryPath = getTlsTrustDisabledCaDirectoryPath(directory);
  await ensureTlsTrustDisabledCaDirectory(emptyDirectoryPath);
  for (const key of ["SSL_CERT_DIR", "GIT_SSL_CAPATH"]) {
    const directoryOverride = process$1.env[key];
    if (directoryOverride && directoryOverride !== emptyDirectoryPath)
      throw new Error(
        `${key} points to an unmanaged CA directory; clear it or use the managed disabled CA directory.`,
      );
  }
  const sources = [];
  const rejected = [];
  const sfwPath =
    process$1.env["SFW_CA_CERT_PATH"] ??
    getDefaultSfwCaCertificatePath(os.homedir());
  const sfwBody = await readTlsBootstrapCaFile(
    sfwPath,
    !process$1.env["SFW_CA_CERT_PATH"],
  );
  const sfwFiltered = filterTlsCertificates(sfwBody ?? "", {
    requireNonEmpty: false,
  });
  rejected.push(...sfwFiltered.rejectedFingerprints);
  sources.push({
    key: "SFW_CA_CERT_PATH",
    path: sfwPath,
    sha256: sfwBody === void 0 ? "missing" : digest(sfwBody),
  });
  const bundlePaths = Object.create(null);
  const bundles = Object.create(null);
  const combine = (name, sourcePem) => {
    const filtered = filterTlsCertificates(
      [sourcePem, sfwFiltered.pem].filter(Boolean).join("\n"),
    );
    bundles[name] = filtered.pem;
    rejected.push(...filtered.rejectedFingerprints);
  };
  const sslFile = process$1.env["SSL_CERT_FILE"];
  if (sslFile) {
    const body = await readTlsBootstrapCaFile(sslFile);
    const filtered = filterTlsCertificates(body);
    sources.push({
      key: "SSL_CERT_FILE",
      path: sslFile,
      sha256: digest(body),
    });
    rejected.push(...filtered.rejectedFingerprints);
    combine("SSL_CERT_FILE", filtered.pem);
  } else {
    const platformPem = [];
    for (const kind of ["bundled", "system"]) {
      const filtered = filterTlsCertificates(await readTlsPlatformRoots(kind), {
        requireNonEmpty: false,
        skipNonCa: true,
      });
      platformPem.push(filtered.pem);
      rejected.push(...filtered.rejectedFingerprints);
      sources.push({
        key: `node-${kind}`,
        path: "",
        sha256: digest(filtered.pem),
        ...(kind === "system"
          ? { environment: captureTlsPlatformEnvironment(process$1.env) }
          : {}),
      });
    }
    combine("SSL_CERT_FILE", platformPem.filter(Boolean).join("\n"));
  }
  bundlePaths["SSL_CERT_FILE"] = getTlsTrustBundlePath(
    directory,
    "SSL_CERT_FILE",
    { sslCertFileName: "ssl-cert-file.pem" },
  );
  for (const key of CA_KEYS.slice(1)) {
    const sourcePath = process$1.env[key];
    if (!sourcePath) continue;
    const body = await readTlsBootstrapCaFile(sourcePath);
    const filtered = filterTlsCertificates(body);
    sources.push({
      key,
      path: sourcePath,
      sha256: digest(body),
    });
    rejected.push(...filtered.rejectedFingerprints);
    bundlePaths[key] = getTlsTrustBundlePath(directory, key);
    combine(key, filtered.pem);
  }
  if (sfwFiltered.pem && !bundlePaths["NODE_EXTRA_CA_CERTS"]) {
    bundlePaths["NODE_EXTRA_CA_CERTS"] = getTlsTrustBundlePath(
      directory,
      "NODE_EXTRA_CA_CERTS",
    );
    combine("NODE_EXTRA_CA_CERTS", "");
  }
  for (const key of CA_KEYS)
    if (!bundlePaths[key]) {
      bundlePaths[key] = bundlePaths["SSL_CERT_FILE"];
      bundles[key] = bundles["SSL_CERT_FILE"];
    }
  for (const [key, file] of Object.entries(bundlePaths))
    await writePrivate(file, bundles[key]);
  const runtime = {
    ...process$1.env,
    ...bundlePaths,
    SSL_CERT_DIR: emptyDirectoryPath,
    GIT_SSL_CAPATH: emptyDirectoryPath,
    NODE_OPTIONS: appendNodeOption(process$1.env["NODE_OPTIONS"]),
  };
  const inspection = inspectTlsEnvironment(runtime, {
    platform: process$1.platform,
    execArgv: process$1.execArgv,
    controlledSslCertDir: emptyDirectoryPath,
  });
  if (!inspection.ok)
    throw new Error([...inspection.conflicts, ...inspection.errors].join(" "));
  if (rejected.length)
    process$1.stderr.write(
      `Filtered blocked CA keys: ${[...new Set(rejected)].join(", ")}\n`,
    );
  const state = {
    bundlePaths,
    emptyDirectoryPath,
    sources,
    version: 1,
  };
  await writePrivate(
    getTlsTrustStatePath(directory),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  return state;
}
async function readState() {
  const directory = rootDirectory();
  const statePath = getTlsTrustStatePath(directory);
  const info = await lstat(statePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    !hasPrivateTlsPermissions(info.mode)
  )
    throw new Error(
      "TLS trust state is missing or unsafe; rerun the setup action.",
    );
  const value = JSON.parse(await readFile(statePath, "utf8"));
  if (
    value.version !== 1 ||
    value.emptyDirectoryPath !==
      getTlsTrustDisabledCaDirectoryPath(directory) ||
    !value.bundlePaths ||
    !Array.isArray(value.sources)
  )
    throw new Error("TLS trust state is invalid; rerun the setup action.");
  for (const key of CA_KEYS)
    if (!Object.hasOwn(value.bundlePaths, key))
      throw new Error("TLS trust state is incomplete; rerun the setup action.");
  for (const [key, file] of Object.entries(value.bundlePaths))
    if (
      !CA_KEYS.includes(key) ||
      path.dirname(path.resolve(file)) !== path.resolve(directory)
    )
      throw new Error(
        "TLS trust state contains an unexpected bundle path; rerun the setup action.",
      );
  return value;
}
async function validateState(state, env = process$1.env) {
  if (
    env["SSL_CERT_DIR"] !== state.emptyDirectoryPath ||
    env["GIT_SSL_CAPATH"] !== state.emptyDirectoryPath
  )
    throw new Error("TLS CA directories changed; rerun the setup action.");
  const liveInspection = inspectTlsEnvironment(
    {
      ...env,
      NODE_OPTIONS: appendNodeOption(env["NODE_OPTIONS"]),
    },
    {
      platform: process$1.platform,
      execArgv: process$1.execArgv,
      controlledSslCertDir: state.emptyDirectoryPath,
    },
  );
  if (!liveInspection.ok)
    throw new Error(
      [...liveInspection.conflicts, ...liveInspection.errors].join(" "),
    );
  const directory = rootDirectory();
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(directoryInfo.mode)
  )
    throw new Error(
      "TLS trust directory is not private; rerun the setup action.",
    );
  validateSfwTlsRuntimeMarkerPair(env);
  const runtimeDirectory = env[TLS_RUNTIME_DIRECTORY_KEY];
  const runtimeRoot = runtimeDirectory
    ? await sfwTlsRuntimeDirectoryRoot(env)
    : void 0;
  const runtimeReady = await runtimeTlsTrustReady(env, state.bundlePaths, {
    ...(runtimeRoot ? { allowedDirectoryRoot: runtimeRoot } : {}),
  });
  if (runtimeDirectory && !runtimeReady)
    throw new Error("TLS runtime bundle changed; rerun the setup action.");
  for (const key of CA_KEYS)
    if (env[key] !== state.bundlePaths[key] && !runtimeReady)
      throw new Error(
        `${key} changed after TLS trust setup; rerun the setup action.`,
      );
  for (const file of Object.values(state.bundlePaths)) {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !hasPrivateTlsPermissions(info.mode)
    )
      throw new Error(
        "A managed TLS bundle is missing or unsafe; rerun the setup action.",
      );
    const content = await readTlsBootstrapCaFile(file);
    if (filterTlsCertificates(content).rejectedFingerprints.length)
      throw new Error(
        "A managed TLS bundle contains a blocked CA; rerun the setup action.",
      );
  }
  if (!(await isTlsTrustDisabledCaDirectorySafe(state.emptyDirectoryPath)))
    throw new Error(
      "Managed disabled CA directory is missing, unsafe, or contains unrecognized files.",
    );
  await validateTlsBootstrapSources(state.sources);
  const runtime = {
    ...env,
    ...state.bundlePaths,
    SSL_CERT_DIR: state.emptyDirectoryPath,
    GIT_SSL_CAPATH: state.emptyDirectoryPath,
    NODE_OPTIONS: appendNodeOption(env["NODE_OPTIONS"]),
  };
  const inspection = inspectTlsEnvironment(runtime, {
    platform: process$1.platform,
    execArgv: process$1.execArgv,
    controlledSslCertDir: state.emptyDirectoryPath,
  });
  if (!inspection.ok)
    throw new Error([...inspection.conflicts, ...inspection.errors].join(" "));
  const expectedStatePath = getTlsTrustStatePath(directory);
  if (env["FLEET_TLS_TRUST_STATE"] !== expectedStatePath)
    throw new Error("TLS trust state path changed; rerun the setup action.");
  if (env["BASH_ENV"] !== bashEnvPath())
    throw new Error(
      "BASH_ENV changed after TLS trust setup; rerun the setup action.",
    );
  const rcInfo = await lstat(bashEnvPath());
  const helperPath = getTlsTrustHelperPath(directory);
  const rcContents = sfwTlsBashEnvContents(helperPath);
  if (
    !rcInfo.isFile() ||
    rcInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(rcInfo.mode) ||
    (await readFile(bashEnvPath(), "utf8")) !== rcContents
  )
    throw new Error("BASH_ENV is missing or unsafe; rerun the setup action.");
  const helperInfo = await lstat(helperPath);
  if (
    !helperInfo.isFile() ||
    helperInfo.isSymbolicLink() ||
    !hasPrivateTlsPermissions(helperInfo.mode)
  )
    throw new Error(
      "TLS bootstrap helper is missing or unsafe; rerun the setup action.",
    );
}
async function installBashEnv(sourceHelper) {
  const existingBashEnv = process$1.env["BASH_ENV"];
  if (existingBashEnv && existingBashEnv !== bashEnvPath())
    throw new Error(
      "BASH_ENV is already set; preserve it and configure filtered TLS trust manually.",
    );
  const directory = rootDirectory();
  const helper = getTlsTrustHelperPath(directory);
  await writePrivate(helper, (await readFile(sourceHelper)).toString("utf8"));
  await writePrivate(bashEnvPath(), sfwTlsBashEnvContents(helper));
}
async function main(args) {
  if (args.length !== 1 || !["--github-env", "--shell"].includes(args[0]))
    throw new Error(
      "Usage: tls-trust-bootstrap.generated.mjs --github-env|--shell",
    );
  if (args[0] === "--github-env") {
    if (
      process$1.env["FLEET_TLS_TRUST_RUNTIME_DIRECTORY"] ||
      process$1.env["FLEET_TLS_TRUST_RUNTIME_CA_SOURCE"]
    )
      throw new Error(
        "Cannot rebuild TLS trust while runtime trust markers are active; restart the job.",
      );
    if (process$1.env["BASH_ENV"]) {
      if (process$1.env["BASH_ENV"] !== bashEnvPath())
        throw new Error(
          "BASH_ENV is already set; preserve it and configure filtered TLS trust manually.",
        );
      await validateState(await readState());
    }
    const state = await buildBundles();
    await installBashEnv(process$1.argv[1]);
    for (const line of sfwTlsEnvironmentLines({
      bundlePaths: state.bundlePaths,
      emptyDirectoryPath: state.emptyDirectoryPath,
      bash: false,
      bashEnvPath: bashEnvPath(),
      statePath: getTlsTrustStatePath(rootDirectory()),
      env: process$1.env,
    }))
      process$1.stdout.write(`${line}\n`);
    return;
  }
  const state = await readState();
  const runtimeEnv = await resolveSfwTlsOverlay(
    process$1.env,
    state.bundlePaths,
    state.emptyDirectoryPath,
    process$1.env["SOCKET_SHIM_ACTIVE_PNPM"] === "1"
      ? await sfwTlsRuntimeDirectoryRoot(process$1.env)
      : "",
  );
  await validateState(state, runtimeEnv);
  for (const line of sfwTlsEnvironmentLines({
    bundlePaths: state.bundlePaths,
    emptyDirectoryPath: state.emptyDirectoryPath,
    bash: true,
    bashEnvPath: bashEnvPath(),
    statePath: getTlsTrustStatePath(rootDirectory()),
    env: runtimeEnv,
    nodeOptions: appendNodeOption(runtimeEnv["NODE_OPTIONS"]),
  }))
    process$1.stdout.write(`${line}\n`);
}
if (isMainModule(import.meta.url))
  main(process$1.argv.slice(2)).catch((error) => {
    process$1.stderr.write(`${(0, import_message.errorMessage)(error)}\n`);
    process$1.exitCode = 1;
  });

export {};

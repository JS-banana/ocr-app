/**
 * Node 22 内置测试（零依赖；--experimental-strip-types 直接 import 旁路 .ts）：
 * 1. manifest/catalog 在 loader 调用前失败，以及有效清单解析。
 * 2. runtime 生命周期：Promise 去重、stale 不建/即毁 Session、Medium 独占、
 *    失败重试、运行期拒绝切换、dispose 后不复活。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ManifestError,
  assetCacheKey,
  catalogCacheKeys,
  parseModelCatalog,
  toModelSummary,
  withBasePath,
} from "./manifest.ts";
import {
  OcrRuntime,
  RuntimeBusyError,
  RuntimeClosedError,
  StaleSelectionError,
} from "./runtime.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

const TINY = "ppocrv6-tiny";
const SMALL = "ppocrv6-small";
const MEDIUM = "ppocrv6-medium";

function manifestFixture() {
  return JSON.parse(readFileSync(join(ROOT, "public/models.json"), "utf8"));
}

describe("withBasePath", () => {
  it("leaves paths unchanged when BASE_PATH is empty", () => {
    assert.equal(withBasePath("/models.json"), "/models.json");
    assert.equal(withBasePath("/ort/"), "/ort/");
  });

  it("prefixes site-root paths when NEXT_PUBLIC_BASE_PATH is set", () => {
    const prev = process.env.NEXT_PUBLIC_BASE_PATH;
    process.env.NEXT_PUBLIC_BASE_PATH = "/ocr-app";
    try {
      assert.equal(withBasePath("/models.json"), "/ocr-app/models.json");
      assert.equal(withBasePath("/ort/"), "/ocr-app/ort/");
      assert.equal(withBasePath("/ocr-app/models.json"), "/ocr-app/models.json");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
      else process.env.NEXT_PUBLIC_BASE_PATH = prev;
    }
  });
});

describe("parseModelCatalog", () => {
  it("accepts the checked-in 3-model manifest and derives downloadBytes", () => {
    const catalog = parseModelCatalog(manifestFixture());
    assert.equal(catalog.models.length, 3);
    const ids = catalog.models.map((m) => m.id);
    assert.deepEqual(ids, [TINY, SMALL, MEDIUM]);

    const tiny = catalog.models[0];
    assert.equal(tiny.pipeline, "ppocr-dbnet-ctc");
    assert.equal(tiny.recommended, true);
    assert.equal(tiny.params.colorOrder, "BGR");
    assert.equal(tiny.params.boxThresh, 0.4);
    assert.equal(tiny.params.dictSize, 6906);

    // Small/Medium：同维数字典（各档自包含 dict.json）、boxThresh 0.45
    for (const m of [catalog.models[1], catalog.models[2]]) {
      assert.equal(m.recommended, false);
      assert.equal(m.params.boxThresh, 0.45);
      assert.equal(m.params.dictSize, 18710);
      assert.equal(m.files.dict.url, `/models/${m.id}/dict.json`);
    }
    assert.equal(tiny.files.det.url, "/models/ppocrv6-tiny/det.onnx");
    assert.equal(tiny.files.dict.url, "/models/ppocrv6-tiny/dict.json");
    const summary = toModelSummary(tiny);
    assert.equal(
      summary.downloadBytes,
      tiny.files.det.sizeBytes +
        tiny.files.rec.sizeBytes +
        tiny.files.dict.sizeBytes,
    );
  });

  it("rejects unknown pipeline before any loader would run", () => {
    const raw = manifestFixture();
    raw.models[0] = { ...raw.models[0], pipeline: "unknown-pipe" };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /unknown-pipe/);
        assert.match(err.message, /pipeline/);
        return true;
      },
    );
  });

  it("rejects missing PP-OCR params with model id and field path", () => {
    const raw = manifestFixture();
    const params = { ...raw.models[0].params };
    delete params.boxThresh;
    raw.models[0] = { ...raw.models[0], params };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /ppocrv6-tiny/);
        assert.match(err.message, /params\.boxThresh/);
        return true;
      },
    );
  });

  it("rejects files that are plain strings (legacy shape)", () => {
    const raw = manifestFixture();
    raw.models[0] = {
      ...raw.models[0],
      files: {
        det: "models/x.onnx",
        rec: "models/y.onnx",
        dict: "models/z.json",
      },
    };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /files\.det/);
        return true;
      },
    );
  });

  it("rejects duplicate ids and multiple recommended flags", () => {
    const raw = manifestFixture();
    const clone = structuredClone(raw.models[0]);
    raw.models.push(clone);
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /重复|recommended/i);
        return true;
      },
    );
  });

  it("rejects non-BGR colorOrder", () => {
    const raw = manifestFixture();
    const params = {
      ...raw.models[0].params,
      colorOrder: "RGB",
    };
    raw.models[0] = { ...raw.models[0], params };
    assert.throws(
      () => parseModelCatalog(raw),
      (err) => {
        assert.ok(err instanceof ManifestError);
        assert.match(err.message, /colorOrder/);
        return true;
      },
    );
  });

  it("rejects backslash / external / query-hash / traversal asset URLs", () => {
    const cases = [
      ["/\\\\evil.example/model.onnx", /反斜杠|外部|models/],
      ["https://evil.example/model.onnx", /外部/],
      ["//evil.example/model.onnx", /外部|本站/],
      ["/models/x.onnx?x=1", /query|hash/],
      ["/models/x.onnx#frag", /query|hash/],
      ["/models/../secret.onnx", /models|穿越|规范/],
      ["/ort/ort.wasm", /models/],
      ["models/x.onnx", /开头/],
    ];
    for (const [url, re] of cases) {
      const raw = manifestFixture();
      raw.models[0] = {
        ...raw.models[0],
        files: {
          ...raw.models[0].files,
          det: { url, sizeBytes: 100 },
        },
      };
      assert.throws(
        () => parseModelCatalog(raw),
        (err) => {
          assert.ok(err instanceof ManifestError, `expected ManifestError for ${url}`);
          assert.match(err.message, /files\.det\.url/);
          assert.match(err.message, re);
          return true;
        },
        `should reject ${url}`,
      );
    }
  });

  it("rejects non-integer detMaxSide / recHeight / recMaxWidth", () => {
    for (const key of ["detMaxSide", "recHeight", "recMaxWidth"]) {
      const raw = manifestFixture();
      raw.models[0] = {
        ...raw.models[0],
        params: { ...raw.models[0].params, [key]: 48.5 },
      };
      assert.throws(
        () => parseModelCatalog(raw),
        (err) => {
          assert.ok(err instanceof ManifestError);
          assert.match(err.message, new RegExp(`params\\.${key}`));
          assert.match(err.message, /正整数/);
          return true;
        },
        `should reject fractional ${key}`,
      );
    }
  });
});

describe("catalog revision cache keys", () => {
  it("builds whole-catalog revision keys for each model file URL", () => {
    const catalog = parseModelCatalog(manifestFixture());
    const keys = catalogCacheKeys(catalog);
    // 三档各 det/rec/dict，路径按 id 分目录，共 9 个独立 Cache 键
    assert.equal(keys.size, 9);
    for (const m of catalog.models) {
      for (const file of Object.values(m.files)) {
        const expected = assetCacheKey(file.url, m.revision);
        assert.ok(keys.has(expected), `missing key ${expected}`);
        assert.match(expected, /\?rev=/);
        assert.ok(expected.startsWith(file.url));
      }
    }
  });
});

describe("local asset byte sizes", () => {
  it("matches models.json sizeBytes to on-disk det/rec/dict for all models", (t) => {
    const catalog = parseModelCatalog(manifestFixture());
    const publicRoot = join(ROOT, "public");
    // 权重为 gitignore 的本地资产（download_models.sh 准备）；fresh clone 缺失时跳过而非报红
    const missing = catalog.models.flatMap((m) =>
      Object.values(m.files)
        .map((f) => join(publicRoot, f.url.replace(/^\//, "")))
        .filter((p) => !existsSync(p)),
    );
    if (missing.length > 0) {
      t.skip(`缺少本地权重 ${missing.length} 个（先跑 download_models.sh）`);
      return;
    }
    for (const m of catalog.models) {
      for (const [name, file] of Object.entries(m.files)) {
        const disk = join(publicRoot, file.url.replace(/^\//, ""));
        const actual = statSync(disk).size;
        assert.equal(
          actual,
          file.sizeBytes,
          `${m.id}/${name}: disk ${actual} ≠ sizeBytes ${file.sizeBytes} (${file.url})`,
        );
      }
    }
  });
});

// ===== Runtime 生命周期 =====

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEntry(id, recommended = false) {
  return {
    id,
    name: id,
    label: id,
    recommended,
    revision: "r1",
    pipeline: "ppocr-dbnet-ctc",
    files: {
      det: { url: `/models/${id}_det.onnx`, sizeBytes: 11 },
      rec: { url: `/models/${id}_rec.onnx`, sizeBytes: 13 },
      dict: { url: `/models/${id}_dict.json`, sizeBytes: 17 },
    },
    params: {
      detMaxSide: 960,
      recHeight: 48,
      recMaxWidth: 3200,
      dictSize: 6906,
      colorOrder: "BGR",
      detThresh: 0.2,
      boxThresh: 0.4,
      unclipRatio: 1.4,
      minBoxSide: 3,
    },
  };
}

const FAKE_IMAGE = { width: 2, height: 2, data: new Uint8ClampedArray(16) };

/**
 * 可控替身：gates 控制 load/create/run 何时放行；events 记录全局顺序。
 * failLoadOnce / failCreateOnce：指定模型首次对应阶段抛错（测重试）。
 */
function makeRuntime({ ids = [TINY, SMALL, MEDIUM], exclusiveIds } = {}) {
  const events = [];
  const gates = { load: null, create: null, run: null };
  const failOnce = { load: new Set(), create: new Set() };
  const catalog = {
    models: ids.map((id, i) => makeEntry(id, i === 0)),
  };

  const loadAssets = async (files, revision, onProgress) => {
    const id = files.det.url.replace("/models/", "").replace("_det.onnx", "");
    events.push(`load:start:${id}`);
    onProgress?.({ pct: 42, label: "下载 det", fromCache: false });
    if (gates.load) await gates.load.promise;
    if (failOnce.load.delete(id)) {
      events.push(`load:fail:${id}`);
      throw new Error(`网络错误(${id})`);
    }
    events.push(`load:done:${id}`);
    return {
      files: {
        det: new ArrayBuffer(11),
        rec: new ArrayBuffer(13),
        dict: new ArrayBuffer(17),
      },
      source: "network",
    };
  };

  const createPipeline = async (entry, files) => {
    const id = entry.id;
    assert.ok(files.det && files.rec && files.dict, "factory 需要 det/rec/dict 字节");
    if (gates.create) await gates.create.promise;
    if (failOnce.create.delete(id)) {
      events.push(`create:fail:${id}`);
      throw new Error(`Session 创建失败(${id})`);
    }
    events.push(`create:${id}`);
    const pipeline = {
      backend: `fake-${id}`,
      run: async () => {
        events.push(`run:start:${id}`);
        if (gates.run) await gates.run.promise;
        events.push(`run:done:${id}`);
        return {
          results: [],
          boxesFound: 0,
          detMs: 1,
          recMs: 1,
          totalMs: 2,
          backend: `fake-${id}`,
        };
      },
      dispose: async () => {
        events.push(`dispose:${id}`);
      },
    };
    return pipeline;
  };

  const stateLog = [];
  const progressLog = [];
  const runtime = new OcrRuntime({
    catalog,
    loadAssets,
    createPipeline,
    exclusiveIds: exclusiveIds ?? new Set([MEDIUM]),
    onState: (id, s) => stateLog.push(`${id}:${s.phase}`),
    onLoadProgress: (id, p) => progressLog.push(`${id}:${Math.round(p.pct)}`),
  });
  return { runtime, events, gates, failOnce, stateLog, progressLog };
}

function assertBefore(events, a, b) {
  const ia = events.indexOf(a);
  const ib = events.indexOf(b);
  assert.ok(ia !== -1, `缺少事件 ${a}（实际: ${events.join(", ")}）`);
  assert.ok(ib !== -1, `缺少事件 ${b}（实际: ${events.join(", ")}）`);
  assert.ok(ia < ib, `期望 ${a} 早于 ${b}（实际: ${events.join(", ")}）`);
}

describe("OcrRuntime 去重与选择", () => {
  it("并发选择同一模型共享一次下载与一次 Session 创建", async () => {
    const { runtime, events } = makeRuntime();
    const p1 = runtime.select(TINY);
    const p2 = runtime.select(TINY);
    await assert.rejects(p1, StaleSelectionError);
    const pipeline = await p2;
    assert.equal(pipeline.backend, `fake-${TINY}`);
    assert.equal(
      events.filter((e) => e === `load:start:${TINY}`).length,
      1,
    );
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);

    // 就绪后重复选择：直接复用，无新增加载/创建
    const again = await runtime.select(TINY);
    assert.equal(again, pipeline);
    assert.equal(
      events.filter((e) => e === `load:start:${TINY}`).length,
      1,
    );
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    assert.equal(runtime.state(TINY).phase, "ready");
    await runtime.dispose();
  });

  it("快速连续切换，最终状态只属于最后选择项", async () => {
    const { runtime, events } = makeRuntime();
    const picks = [
      runtime.select(TINY).catch((e) => e),
      runtime.select(SMALL).catch((e) => e),
      runtime.select(MEDIUM).catch((e) => e),
      runtime.select(TINY).catch((e) => e),
    ];
    const last = runtime.select(SMALL);
    const settled = await Promise.all([...picks, last]);
    for (const r of settled.slice(0, -1)) {
      assert.ok(r instanceof StaleSelectionError, `期望 stale，实际 ${r}`);
    }
    await last;
    assert.equal(runtime.selectedId(), SMALL);
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    // 只创建了最终选择项（SMALL 加载去重后一次创建）
    assert.equal(events.filter((e) => e.startsWith("create:")).length, 1);
    assert.ok(events.includes(`create:${SMALL}`));
    await runtime.dispose();
  });

  it("进度与状态事件向外投影", async () => {
    const { runtime, stateLog, progressLog } = makeRuntime();
    await runtime.select(TINY);
    assert.ok(progressLog.some((p) => p.startsWith(`${TINY}:`)));
    assert.ok(stateLog.includes(`${TINY}:loading`));
    assert.ok(stateLog.includes(`${TINY}:ready`));
    assert.equal(runtime.state(TINY).backend, `fake-${TINY}`);
    assert.equal(runtime.state(TINY).source, "network");
    await runtime.dispose();
  });
});

describe("OcrRuntime stale 与常驻策略", () => {
  it("加载中被取代：不创建 Session，槽位回到 unloaded", async () => {
    const { runtime, events, gates } = makeRuntime();
    gates.load = deferred();
    const stalePick = runtime.select(TINY);
    const winner = runtime.select(SMALL);
    gates.load.resolve();
    await assert.rejects(stalePick, StaleSelectionError);
    await winner;
    assert.ok(!events.some((e) => e === `create:${TINY}`));
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "ready");
    await runtime.dispose();
  });

  it("Session 创建完成但已过期：立即 dispose，不进入常驻", async () => {
    const { runtime, events, gates } = makeRuntime();
    gates.create = deferred();
    const stalePick = runtime.select(TINY);
    // 等 tiny 进入 create 临界区后再切换
    await new Promise((r) => setImmediate(r));
    const winner = runtime.select(SMALL);
    gates.create.resolve();
    await assert.rejects(stalePick, StaleSelectionError);
    await winner;
    assertBefore(events, `dispose:${TINY}`, `create:${SMALL}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "ready");
    await runtime.dispose();
  });

  it("Tiny/Small 常驻共存，切回复用不重建", async () => {
    const { runtime, events } = makeRuntime();
    const tiny1 = await runtime.select(TINY);
    await runtime.select(SMALL);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.ok(!events.some((e) => e.startsWith("dispose:")));

    const tiny2 = await runtime.select(TINY);
    assert.equal(tiny2, tiny1);
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    await runtime.dispose();
  });

  it("Medium 独占：创建前释放 Tiny/Small，离开时先释放 Medium", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.select(TINY);
    await runtime.select(SMALL);
    await runtime.select(MEDIUM);
    assertBefore(events, `dispose:${TINY}`, `create:${MEDIUM}`);
    assertBefore(events, `dispose:${SMALL}`, `create:${MEDIUM}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.state(SMALL).phase, "unloaded");
    assert.equal(runtime.state(MEDIUM).phase, "ready");

    await runtime.select(TINY);
    assert.ok(
      events.lastIndexOf(`dispose:${MEDIUM}`) <
        events.lastIndexOf(`create:${TINY}`),
      `期望最后一次 dispose:${MEDIUM} 早于重建 create:${TINY}（实际: ${events.join(", ")}）`,
    );
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    assert.equal(runtime.state(TINY).phase, "ready");
    await runtime.dispose();
  });

  it("防御分支：alreadyReady 快捷路径仍清除残留的独占 Session", async () => {
    const { runtime, events } = makeRuntime();
    await runtime.select(TINY);
    // 白盒构造不变量破坏残留态（TS private 仅编译期；正常流程不可达此态）
    const slot = runtime.slots.get(MEDIUM);
    slot.pipeline = {
      backend: "fake-stuck-medium",
      run: async () => {
        throw new Error("不应运行残留 pipeline");
      },
      dispose: async () => {
        events.push(`dispose:${MEDIUM}`);
      },
    };
    slot.phase = "ready";
    slot.backend = "fake-stuck-medium";

    // Tiny 已 ready → 走 alreadyReady 快捷路径 → enforceResidency 应释放 Medium
    const pipeline = await runtime.select(TINY);
    assert.equal(pipeline.backend, `fake-${TINY}`);
    assert.ok(events.includes(`dispose:${MEDIUM}`));
    assert.equal(runtime.state(MEDIUM).phase, "unloaded");
    assert.equal(runtime.state(TINY).phase, "ready");
    // 无新创建（复用常驻 Tiny）
    assert.equal(events.filter((e) => e === `create:${TINY}`).length, 1);
    await runtime.dispose();
  });

  it("exclusiveIds 含未知 id 时构造即失败", () => {
    assert.throws(
      () =>
        makeRuntime({ exclusiveIds: new Set(["ppocrv6-unknown"]) }),
      /未知模型 id/,
    );
  });

  it("catalog 无 medium 时默认 exclusiveIds 为空，可正常构造", () => {
    const catalog = {
      models: [
        {
          id: TINY,
          name: "Tiny",
          label: "快速",
          recommended: true,
          revision: "t",
          pipeline: "ppocr-dbnet-ctc",
          files: {
            det: { url: "/models/ppocrv6-tiny/det.onnx", sizeBytes: 11 },
            rec: { url: "/models/ppocrv6-tiny/rec.onnx", sizeBytes: 13 },
            dict: { url: "/models/ppocrv6-tiny/dict.json", sizeBytes: 17 },
          },
          params: {
            detMaxSide: 960,
            recHeight: 48,
            recMaxWidth: 3200,
            dictSize: 6906,
            colorOrder: "BGR",
            detThresh: 0.2,
            boxThresh: 0.4,
            unclipRatio: 1.4,
            minBoxSide: 3,
          },
        },
      ],
    };
    const rt = new OcrRuntime({
      catalog,
      loadAssets: async () => {
        throw new Error("unused");
      },
    });
    assert.deepEqual(rt.ids(), [TINY]);
    void rt.dispose();
  });
});

describe("OcrRuntime 失败重试", () => {
  it("下载失败与 Session 创建失败均保留错误，重试先清失败再成功", async () => {
    const { runtime, failOnce } = makeRuntime();
    failOnce.load.add(TINY);
    failOnce.create.add(TINY);

    await assert.rejects(runtime.select(TINY), /网络错误/);
    let st = runtime.state(TINY);
    assert.equal(st.phase, "failed");
    assert.match(st.error, /网络错误/);

    await assert.rejects(runtime.select(TINY), /Session 创建失败/);
    st = runtime.state(TINY);
    assert.equal(st.phase, "failed");
    assert.match(st.error, /Session 创建失败/);

    await runtime.select(TINY);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(TINY).error, null);
    await runtime.dispose();
  });

  it("失败后错误保留在原模型卡上，可改选其他模型，也可重试", async () => {
    const { runtime, failOnce } = makeRuntime();
    failOnce.create.add(TINY);
    await assert.rejects(runtime.select(TINY));

    // 改选其他模型：Tiny 的失败状态保留（供卡片展示错误与重试入口）
    await runtime.select(SMALL);
    assert.equal(runtime.selectedId(), SMALL);
    assert.equal(runtime.state(SMALL).phase, "ready");
    assert.equal(runtime.state(TINY).phase, "failed");
    assert.match(runtime.state(TINY).error, /Session 创建失败/);

    // 重试 Tiny：先清失败再加载，最终就绪
    await runtime.select(TINY);
    assert.equal(runtime.state(TINY).phase, "ready");
    assert.equal(runtime.state(TINY).error, null);
    await runtime.dispose();
  });
});

describe("OcrRuntime 运行期收口", () => {
  it("run 固定当前 Pipeline；运行期间拒绝切换与并发 run", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.run = deferred();
    await runtime.select(TINY);

    const runPromise = runtime.run(FAKE_IMAGE);
    await new Promise((r) => setImmediate(r));
    assert.equal(runtime.isBusy(), true);

    await assert.rejects(runtime.select(SMALL), RuntimeBusyError);
    await assert.rejects(runtime.run(FAKE_IMAGE), RuntimeBusyError);
    assert.equal(runtime.selectedId(), TINY);
    assert.equal(runtime.state(TINY).phase, "ready");

    gates.run.resolve();
    const out = await runPromise;
    assert.equal(out.backend, `fake-${TINY}`);
    assert.equal(runtime.isBusy(), false);
    assert.ok(!events.some((e) => e.startsWith("dispose:")));
    await runtime.dispose();
  });

  it("未选择/未就绪时 run 直接失败", async () => {
    const { runtime } = makeRuntime();
    await assert.rejects(runtime.run(FAKE_IMAGE), /尚未选择模型/);
    await runtime.dispose();
  });
});

describe("OcrRuntime dispose 收口", () => {
  it("加载中 dispose：pending load 不复活，之后 select/run 拒绝", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.load = deferred();
    const pick = runtime.select(TINY);
    const disposed = runtime.dispose();
    gates.load.resolve();
    await assert.rejects(pick, RuntimeClosedError);
    await disposed;

    assert.ok(!events.some((e) => e.startsWith("create:")));
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.isClosed(), true);
    await assert.rejects(runtime.select(TINY), RuntimeClosedError);
    await assert.rejects(runtime.run(FAKE_IMAGE), RuntimeClosedError);
    // 重复 dispose 安全
    await runtime.dispose();
  });

  it("Session 创建中 dispose：创建完成即销毁，不停留", async () => {
    const { runtime, gates, events } = makeRuntime();
    gates.create = deferred();
    const pick = runtime.select(TINY);
    await new Promise((r) => setImmediate(r));
    const disposed = runtime.dispose();
    gates.create.resolve();
    await assert.rejects(pick, RuntimeClosedError);
    await disposed;
    assertBefore(events, `create:${TINY}`, `dispose:${TINY}`);
    assert.equal(runtime.state(TINY).phase, "unloaded");
  });

  it("run 进行中 dispose：等待运行收口后释放 Session", async () => {
    const { runtime, gates } = makeRuntime();
    gates.run = deferred();
    await runtime.select(TINY);
    const runPromise = runtime.run(FAKE_IMAGE);
    await new Promise((r) => setImmediate(r));

    let disposeDone = false;
    const disposed = runtime.dispose().then(() => {
      disposeDone = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(disposeDone, false, "run 未收口前 dispose 不应完成");

    gates.run.resolve();
    await runPromise;
    await disposed;
    assert.equal(runtime.state(TINY).phase, "unloaded");
    assert.equal(runtime.isClosed(), true);
  });
});

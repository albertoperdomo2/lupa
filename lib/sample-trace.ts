import type { TraceData, TraceEvent } from "./trace-types";

function generateVLLMTrace(): TraceEvent[] {
  const events: TraceEvent[] = [];
  
  // Process -1 (system events)
  events.push({
    name: "process_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: -1,
    tid: 0,
    args: { name: "Process -1" },
  });

  // VLLM Worker Process (pid: 448)
  events.push({
    name: "process_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: 448,
    tid: 0,
    args: { name: "VLLM::Worker_TP1 (pid 448): CPU" },
  });

  // Main thread
  events.push({
    name: "thread_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: 448,
    tid: 448,
    args: { name: "thread 448 (VLLM::Worker_TP)" },
  });

  // Generate nested flame graph style events
  const baseTime = 0;
  const totalDuration = 10_000_000; // 10 seconds in microseconds
  
  // Layer 1: Top-level bootstrap events
  const bootstrapEvents = [
    "threading.py(1032): _bootstrap",
    "threading.py(1075): _bootstrap_inner",
    "kgmr_monitor.py(83): run",
    "threading.py(309): wait",
    "threading.py(1032): _bootstrap",
    "threading.py(1075): _bootstrap_inner",
    "kgmr_monitor.py(83): run",
  ];

  let currentTime = baseTime + 500_000;
  
  // Create repeating pattern of nested events
  for (let cycle = 0; cycle < 10; cycle++) {
    const cycleStart = currentTime;
    const cycleDuration = 800_000;
    
    // Top level: threading bootstrap
    events.push({
      name: "threading.py(1032): _bootstrap",
      cat: "python",
      ph: "X",
      ts: cycleStart,
      dur: cycleDuration,
      pid: 448,
      tid: 448,
      cname: "thread_state_sleeping",
    });

    // Nested: bootstrap_inner
    events.push({
      name: "threading.py(1075): _bootstrap_inner",
      cat: "python",
      ph: "X",
      ts: cycleStart + 10000,
      dur: cycleDuration - 20000,
      pid: 448,
      tid: 448,
      cname: "cq_build_passed",
    });

    // Nested deeper: various vllm calls
    const innerEvents = [
      { name: "vllm/v1/executor/multiproc_executor.py(61): async_output_loop", dur: 150000, cname: "rail_response" },
      { name: "spawn.py(71): _get", dur: 50000, cname: "generic_work" },
      { name: "threading.py(309): wait", dur: 80000, cname: "thread_state_sleeping" },
      { name: "threading.py(1032): _bootstrap", dur: 100000, cname: "thread_state_sleeping" },
      { name: "threading.py(1075): _bootstrap_inner", dur: 90000, cname: "cq_build_passed" },
      { name: "multiprocessing/process.py(108): run", dur: 70000, cname: "rail_load" },
      { name: "multiprocessing/connection.py(250): recv", dur: 60000, cname: "good" },
      { name: "multiprocessing/connection.py(430): _recv_bytes", dur: 40000, cname: "good" },
      { name: "<string>(1): <module>", dur: 30000, cname: "bad" },
      { name: "multiprocessing/spawn.py(122): spawn_main", dur: 80000, cname: "generic_work" },
      { name: "multiprocessing/spawn.py(135): _main", dur: 70000, cname: "generic_work" },
      { name: "multiprocessing/process.py(314): _bootstrap", dur: 90000, cname: "rail_animation" },
      { name: "multiprocessing/process.py(108): run", dur: 60000, cname: "rail_load" },
    ];

    let innerTime = cycleStart + 50000;
    for (const evt of innerEvents) {
      if (innerTime + evt.dur < cycleStart + cycleDuration - 20000) {
        events.push({
          name: evt.name,
          cat: "python",
          ph: "X",
          ts: innerTime,
          dur: evt.dur,
          pid: 448,
          tid: 448,
          cname: evt.cname,
        });
        innerTime += evt.dur + Math.random() * 20000;
      }
    }

    currentTime += cycleDuration + 100000;
  }

  // Add worker events with nested structure (flame graph)
  const workerBaseTime = 1_000_000;
  
  // Multiple rows of dense events like in the screenshot
  for (let row = 0; row < 12; row++) {
    const rowStart = workerBaseTime + row * 5000;
    
    for (let col = 0; col < 12; col++) {
      const colStart = rowStart + col * 800_000;
      const eventDur = 700_000 + Math.random() * 100_000;
      
      // Layer 1
      events.push({
        name: `vllm/v1/worker/worker_base.py(260): ...`,
        cat: "vllm",
        ph: "X",
        ts: colStart,
        dur: eventDur,
        pid: 448,
        tid: 448,
        cname: "cq_build_running",
      });

      // Layer 2 - nested events
      const nestedEvents = [
        { name: "vllm/attention.py(188): _wrapped", cname: "olive" },
        { name: "torch/utils/_contextlib.py(117): ...", cname: "rail_response" },
        { name: "vllm/v1/worker/gpu_model_ru...", cname: "thread_state_sleeping" },
        { name: "vllm/compilation/decorators.py...", cname: "bad" },
        { name: "vllm/compilation/wrapper.py(105)...", cname: "generic_work" },
        { name: "vllm/model_executor/models/llama...", cname: "rail_animation" },
        { name: "torch/_dynamo/eval_frame.py...", cname: "thread_state_sleeping" },
        { name: "torch/fragment_module.py(900)...", cname: "olive" },
        { name: "nn.Module: GraphModule_0", cname: "vsync_highlight_color" },
        { name: "torch/nn/modules/module.py(177...", cname: "rail_load" },
        { name: "<emit_with_key>-182d4: forward", cname: "cq_build_passed" },
      ];

      let nestedTime = colStart + 20000;
      const layerHeight = eventDur / (nestedEvents.length + 2);
      
      for (let i = 0; i < nestedEvents.length; i++) {
        const nestDur = eventDur - 40000 - (i * layerHeight * 0.8);
        if (nestDur > 10000) {
          events.push({
            name: nestedEvents[i].name,
            cat: "vllm",
            ph: "X",
            ts: nestedTime + i * 8000,
            dur: Math.max(nestDur, 50000),
            pid: 448,
            tid: 448,
            cname: nestedEvents[i].cname,
          });
        }
      }
    }
  }

  // Add more thread workers like in the screenshot
  const workerThreads = [
    { tid: 449, name: "thread 449 (vllm::Worker_TP)" },
    { tid: 450, name: "thread 450 (cuda_stream)" },
    { tid: 451, name: "thread 451 (inference)" },
  ];

  for (const thread of workerThreads) {
    events.push({
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid: 448,
      tid: thread.tid,
      args: { name: thread.name },
    });

    // Add events for each thread
    let threadTime = 500_000;
    for (let i = 0; i < 50; i++) {
      const dur = 50000 + Math.random() * 200000;
      events.push({
        name: `worker_op_${i}`,
        cat: "worker",
        ph: "X",
        ts: threadTime,
        dur,
        pid: 448,
        tid: thread.tid,
        cname: ["good", "bad", "generic_work", "rail_response", "olive"][Math.floor(Math.random() * 5)],
      });
      threadTime += dur + Math.random() * 50000;
    }
  }

  return events;
}

export const sampleTraceData: TraceData = {
  traceEvents: generateVLLMTrace(),
  metadata: {
    "command_line": "python -m vllm.entrypoints.api_server",
    "cpu-brand": "AMD EPYC 7R32",
    "network-type": "ethernet",
    "num-cpus": 48,
    "os-arch": "x86_64",
    "os-name": "Linux",
    "os-version": "5.15.0",
    "physical-memory": 196608,
    "trace-capture-datetime": "2026-03-27T08:25:00Z",
  },
};

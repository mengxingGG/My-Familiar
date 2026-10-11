export function createVoiceSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  const page = $("voice");
  const profile = (slot, live = false) => `<div class="panel panel-form">
    <div class="field-grid">
      <label class="field">接口<select id="voice-${slot}-kind">${live ? '<option value="openai">OpenAI Realtime 兼容</option><option value="gemini">Gemini Live</option>' : `${slot === "tts" ? '<option value="system">Windows 本地语音（不需要 Key）</option>' : ""}<option value="compatible">OpenAI 兼容</option><option value="openrouter">OpenRouter</option>`}</select></label>
      <label class="field">API 地址<input id="voice-${slot}-baseUrl" spellcheck="false"></label>
      <label class="field">模型 ID（可选择或手填）<input id="voice-${slot}-model" list="voice-${slot}-models" spellcheck="false"><datalist id="voice-${slot}-models"></datalist></label>
      ${slot !== "stt" ? `<label class="field">音色（可选择或手填）<input id="voice-${slot}-voice" list="voice-${slot}-voices" spellcheck="false"><datalist id="voice-${slot}-voices"></datalist></label>` : ""}
    </div>
    <div class="button-row"><button id="voice-${slot}-catalog" class="quiet">获取模型和音色</button><small id="voice-${slot}-note"></small></div>
    <label class="field">这个接口的 API Key<span class="inline-field"><input id="voice-${slot}-key" type="password" autocomplete="off" placeholder="留空则保留已保存的密钥"><button id="voice-${slot}-save-key" class="quiet">保存密钥</button></span><small id="voice-${slot}-key-state"></small></label>
  </div>`;
  page.innerHTML = `
    <div class="toc" role="navigation" aria-label="本页分区"><a href="#voice-sec-talk">语音对话</a><a href="#voice-sec-mode">对话方式</a><a href="#voice-sec-wake">唤醒</a><a href="#voice-sec-sound">宠物的声音</a><a href="#voice-sec-engine">接口</a><a href="#voice-sec-image">图片与截图</a><a href="#voice-sec-cache">音频缓存</a></div>
    <div id="voice-loading" class="banner banner-warn"><p id="voice-loading-message">正在读取语音设置…</p><button id="voice-retry" class="quiet">重新载入</button></div>
    <div class="group" id="voice-sec-talk"><div class="voice-live">
      <div><p id="voice-state" aria-live="polite">语音未开启</p><small>开始后可以直接说话。它朗读时你开口，会打断它。</small></div>
      <div class="button-row"><button id="voice-start" class="primary">开始对话</button><button id="voice-stop" class="quiet">停止语音</button><button id="voice-wake-test" class="quiet">测试唤醒 20 秒</button></div>
      <div id="voice-wake-diagnostics" class="voice-meter"><label>待机麦克风音量<meter id="voice-wake-level" min="0" max="100" value="0"></meter></label><small id="voice-wake-detail">待机时显示麦克风输入，不保存录音。</small></div>
    </div></div>
    <div class="group" id="voice-sec-mode"><h3>对话方式</h3><div class="panel">
      <div class="panel-form"><label class="field">语音对话使用<select id="voice-mode"><option value="chained">常规语音：识别后交给主模型，再用宠物的声音朗读</option><option value="realtime">Live 接口：目前仍由主模型代为回答</option></select></label>
      <p id="voice-mode-limit" class="notice-text">快速、自然的原生 Live 对话，需要你自己接入支持实时音频的 Live 模型。常规模式按“识别 → 主模型 → 朗读”逐段处理，会尽量缩短等待，但做不到边听边说。只配置文字模型、识别或合成，不等于接入了 Live。</p></div>
      <label class="row-setting"><div class="row-text"><b>唤醒后持续对话，直到手动结束</b><small>不用每轮重复叫它，普通停顿也不会挂断。对话期间麦克风一直开着；使用云端接口时会持续发送音频，停止语音后结束。</small></div><input type="checkbox" id="voice-continuous" role="switch"></label>
      <div class="row-setting"><div class="row-text"><b>停顿与空闲</b><small>关闭持续对话后，朗读结束才开始计算空闲。停顿时长只用于常规模式。建议先戴耳机试。</small></div><div class="button-row"><span class="unit-field"><input id="voice-idle" type="number" min="5" max="600" aria-label="空闲多久回到待机"><span>秒后待机</span></span><span class="unit-field"><input id="voice-silence" type="number" min="300" max="3000" step="100" aria-label="说完后的停顿"><span>毫秒算说完</span></span></div></div>
      <label class="row-setting"><div class="row-text"><b>文字消息也自动朗读回复</b><small>关闭时，可以在气泡或历史会话里手动点“朗读”。</small></div><input type="checkbox" id="voice-autoread" role="switch"></label>
    </div></div>
    <div class="group" id="voice-sec-wake"><h3>唤醒</h3><div class="panel">
      <label class="row-setting"><div class="row-text"><b>待机时叫名字唤醒</b><small>在本机识别，不上传待机音频。</small></div><input type="checkbox" id="voice-enabled" role="switch"></label>
      <div class="panel-form"><label class="field">唤醒词<input id="voice-phrases" placeholder="留空则使用宠物的名字；多个唤醒词用逗号分隔"><small>例如设置“小森”，说“小森在吗”“小森起床啦”都能唤醒。</small></label>
      <label class="field">灵敏度<span class="range"><input id="voice-sensitivity" type="range" min="0" max="100" step="1"><output id="voice-sensitivity-value">50</output></span><small>调低更严格，减少误唤醒；调高更容易唤醒，也更容易听错。不会改变麦克风音量。</small></label></div>
    </div></div>
    <div class="group" id="voice-sec-sound"><h3>宠物的声音</h3><div class="panel">
      <div class="panel-form"><label class="field">声音<select id="voice-identity"><option value="persona">按性格推荐的原创声音</option><option value="gentle">森铃：清亮柔软的小精灵</option><option value="thorough">团团：圆润耐心的小伙伴</option><option value="provider">服务商音色（自己指定）</option></select><small>固定的声音不会随主模型改变。换语音模型时沿用同一份参考声音；新模型不支持声音克隆时保留原设置。</small></label></div>
      <label class="row-setting"><div class="row-text"><b>语气跟随性格</b><small>性格影响措辞；额外的语气控制需要接口支持。</small></div><input type="checkbox" id="voice-persona" role="switch"></label>
      <div class="row-setting"><div class="row-text"><b>试听原创声音</b><small>播放随程序附带的录音，不调用接口、不产生费用。</small></div><div id="voice-previews" class="previews"></div></div>
      <div class="row-setting"><div class="row-text"><b>一键使用推荐配置</b><small>常规语音，加上 OpenRouter 上的 Fish 模型和原创参考声音。</small></div><button id="voice-pet-default" class="quiet">使用推荐配置</button></div>
    </div></div>
    <div id="voice-sec-engine">
      <div id="voice-chained">
        <div class="group"><h3>语音识别：听你说</h3>${profile("stt")}
          <div class="panel panel-form" style="margin-top:10px"><div class="field-grid"><label class="field">识别语言（可选）<input id="voice-stt-language" placeholder="留空自动判断；中文可填 zh" maxlength="12"></label><label class="field">名字与专有词提示（可选）<textarea id="voice-stt-prompt" rows="2" maxlength="500" placeholder="例如：小森、Familiar"></textarea></label></div><small>提示不保证提高准确率。接口报错时清空它，就会恢复默认请求。</small></div></div>
        <div class="group"><h3>语音合成：说给你听</h3>${profile("tts")}
          <div class="panel" style="margin-top:10px">
            <div class="row-setting"><div class="row-text"><b>语速</b></div><span class="unit-field"><input id="voice-speed" type="number" min="0.5" max="2" step="0.05" aria-label="语速"><span>倍</span></span></div>
            <label class="row-setting"><div class="row-text"><b>边收边播（PCM 流式）</b><small>接口支持时，整句合成完之前就开始说。接口需要返回正确的采样率；不支持就关掉，改用短句播放。</small></div><input type="checkbox" id="voice-stream" role="switch"></label>
            <label class="row-setting"><div class="row-text"><b>附带参考音频</b><small>只在接口明确支持 input_references 时有效，用于保持宠物声线。使用服务商音色时不需要开启。</small></div><input type="checkbox" id="voice-reference" role="switch"></label>
            <div class="row-setting"><div class="row-text"><b>试读一句</b><small>用当前接口合成，会产生费用。</small></div><button id="voice-test" class="quiet">试读</button></div>
          </div></div>
      </div>
      <div id="voice-live" class="group"><h3>Live 接口</h3>
        <div class="panel panel-form"><p class="group-note" style="margin:0">需要支持实时音频的模型、正确的接口地址和账户权限；官方云端接口需要单独的 Live API Key。目前 OpenAI 和 Gemini 的适配仍会先等主模型回答，还不是原生 Live 的最快体验。请选择“服务商音色”；固定的宠物声音请继续使用常规语音。</p><p id="voice-readiness" class="notice-text" aria-live="polite"></p><div id="voice-live-recommendations" class="list" style="gap:8px"></div></div>
        <div style="margin-top:10px">${profile("live", true)}</div>
      </div>
    </div>
    <div class="group" id="voice-sec-image"><h3>图片与截图</h3><div class="panel">
      <label class="row-setting"><div class="row-text"><b>允许宠物在你提问时截图</b><small>图片交给当前主模型，请选择支持图片的模型。只按次截图，不持续录屏。</small></div><input type="checkbox" id="media-enabled" role="switch"></label>
      <label class="row-setting"><div class="row-text"><b>提到屏幕、桌面或关卡时自动附图</b></div><input type="checkbox" id="media-auto" role="switch"></label>
      <label class="row-setting"><div class="row-text"><b>截取哪个显示器</b></div><select id="media-display" style="width:220px"></select></label>
      <div class="row-setting"><div class="row-text"><small>也可以在宠物输入框里添加图片、PDF、Word 或文本文件。手动截图只授权这一次。</small></div><button class="primary" id="media-save">保存图片设置</button></div>
    </div></div>
    <div class="group" id="voice-sec-cache"><h3>音频缓存</h3><div class="panel">
      <div class="row-setting"><div class="row-text"><b>保留时长与上限</b><small>0 天表示不保留。相同的文字、音色和参数会复用缓存；录音默认不保存，随程序附带的试听不会被清理。</small></div><div class="button-row"><span class="unit-field"><input id="voice-days" type="number" min="0" max="365" aria-label="缓存保留天数"><span>天</span></span><span class="unit-field"><input id="voice-size" type="number" min="16" max="2048" aria-label="缓存上限"><span>MB</span></span></div></div>
      <div class="row-setting"><div class="row-text"><small id="voice-cache-state">清理会删除过期和超出上限的音频。</small></div><button id="voice-cache" class="quiet">清理过期缓存</button></div>
    </div></div>
    <div class="page-actions"><span class="hint">图片设置单独保存；其余设置用右边的按钮保存。</span><button id="voice-save" class="primary">保存语音设置</button></div>`;
  // 页内跳转只滚动，不改地址，避免触发窗口导航。
  page.querySelector(".toc").onclick = (e) => {
    const link = e.target.closest("a");
    if (!link) return;
    e.preventDefault();
    $(link.getAttribute("href").slice(1)).scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };
  const editable = [
    ...page.querySelectorAll("input,select,textarea,button"),
  ].filter((v) => v.id !== "voice-retry");
  editable.forEach((v) => (v.disabled = true));
  let settings,
    loaded = false,
    loading = false,
    poll;
  const run = (fn) => async (event) => {
    const b = event?.currentTarget;
    if (b) b.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (b) b.disabled = false;
    }
  };
  const fields = {
    enabled: "enabled",
    autoRead: "autoread",
    followPersona: "persona",
    continuous: "continuous",
  };
  const numbers = {
    wakeSensitivity: "sensitivity",
    idleSeconds: "idle",
    silenceMs: "silence",
    cacheDays: "days",
    cacheMaxMB: "size",
  };
  function visibility() {
    $("voice-chained").hidden = $("voice-mode").value !== "chained";
    $("voice-live").hidden = $("voice-mode").value !== "realtime";
    $("voice-sensitivity-value").value = $("voice-sensitivity").value;
    $("voice-idle").disabled = !loaded || $("voice-continuous").checked;
    $("voice-silence").disabled =
      !loaded || $("voice-mode").value === "realtime";
  }
  function read() {
    const c = structuredClone(settings);
    for (const [key, id] of Object.entries(fields))
      c[key] = $("voice-" + id).checked;
    for (const [key, id] of Object.entries(numbers))
      c[key] = Number($("voice-" + id).value);
    c.wakeEnabled = c.enabled;
    c.mode = $("voice-mode").value;
    c.wakePhrases = $("voice-phrases")
      .value.split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    c.identity = $("voice-identity").value;
    for (const slot of ["stt", "tts", "live"])
      for (const field of [
        "kind",
        "baseUrl",
        "model",
        ...(slot === "stt" ? [] : ["voice"]),
      ])
        c[slot][field] = $("voice-" + slot + "-" + field).value.trim();
    c.tts.speed = Number($("voice-speed").value);
    c.tts.reference = $("voice-reference").checked;
    c.tts.stream = $("voice-stream").checked;
    c.stt.language = $("voice-stt-language").value.trim();
    c.stt.prompt = $("voice-stt-prompt").value.trim();
    return c;
  }
  async function save() {
    if (!loaded) throw new Error("请等待设置载入");
    settings = await api.request("voice.save", read());
  }
  const status = (v) => {
    if (v.readiness)
      $("voice-readiness").textContent = v.readiness.problems.length
        ? "已保存配置待补充：" + v.readiness.problems.join("；")
        : v.readiness.summary;
    $("voice-state").textContent = [v.message, v.error]
      .filter(Boolean)
      .join(" · ");
    if (v.wake) {
      $("voice-wake-level").value = v.wake.level ?? 0;
      $("voice-wake-detail").textContent = v.wake.listening
        ? `正在监听 Windows 默认输入 · 当前 ${v.wake.level ?? 0} / 峰值 ${v.wake.peak ?? 0} · ${v.wake.lastResult || "请叫一下宠物名字；音量始终为 0 时检查系统默认输入、静音及麦克风权限"}`
        : v.active
          ? "连续对话中，待机唤醒已暂停，麦克风用于接话"
          : v.wake.message;
    }
  };
  async function load() {
    if (loaded || loading) return;
    loading = true;
    try {
      const [v, m] = await Promise.all([
        api.request("voice.get"),
        api.request("media.get"),
      ]);
      settings = v.settings;
      for (const [key, id] of Object.entries(fields))
        $("voice-" + id).checked = settings[key];
      for (const [key, id] of Object.entries(numbers))
        $("voice-" + id).value = settings[key];
      $("voice-mode").value = settings.mode;
      $("voice-phrases").value = settings.wakePhrases.join("，");
      $("voice-identity").value = settings.identity;
      $("voice-speed").value = settings.tts.speed;
      $("voice-reference").checked = settings.tts.reference;
      $("voice-stream").checked = settings.tts.stream !== false;
      $("voice-stt-language").value = settings.stt.language ?? "";
      $("voice-stt-prompt").value = settings.stt.prompt ?? "";
      $("voice-live-recommendations").replaceChildren(
        ...(v.recommendations ?? []).map((item) => {
          const row = document.createElement("div"),
            title = document.createElement("b"),
            note = document.createElement("p");
          row.className = "recommendation";
          title.textContent = `${item.name}（${item.model}）`;
          note.textContent = item.note;
          row.append(title, note);
          if (item.profile) {
            const use = document.createElement("button");
            use.className = "quiet";
            use.textContent = "填入这套配置";
            use.onclick = () => {
              for (const [field, value] of Object.entries(item.profile))
                $("voice-live-" + field).value = value;
              $("voice-live-key").value = "";
              $("voice-live-models").replaceChildren();
              $("voice-live-voices").replaceChildren();
              $("voice-live-key-state").textContent =
                "保存后核对此接口的独立密钥";
              toast(
                "已填入草稿；请确认声音身份，保存设置并配置此 Live 接口密钥",
              );
            };
            row.append(use);
          }
          return row;
        }),
      );
      for (const slot of ["stt", "tts", "live"]) {
        for (const field of [
          "kind",
          "baseUrl",
          "model",
          ...(slot === "stt" ? [] : ["voice"]),
        ])
          $("voice-" + slot + "-" + field).value = settings[slot][field];
        $("voice-" + slot + "-key-state").textContent = v.keys[slot]
          ? "已加密保存"
          : "未保存密钥";
      }
      $("media-enabled").checked = m.settings.screenEnabled;
      $("media-auto").checked = m.settings.autoScreen;
      $("media-display").replaceChildren(
        ...m.displays.map((d) => new Option(d.name, d.id)),
      );
      $("media-display").value = m.settings.displayId;
      $("voice-previews").replaceChildren(
        ...v.personas.map((p) => {
          const b = document.createElement("button");
          b.className = "quiet";
          b.textContent = "▶ " + p.name;
          b.setAttribute("aria-label", "试听 " + p.name);
          b.title = p.text;
          b.onclick = run(() => api.request("voice.preview", { id: p.id }));
          return b;
        }),
      );
      loaded = true;
      editable.forEach((v) => (v.disabled = false));
      $("voice-loading").hidden = true;
      visibility();
      status({ ...v.state, readiness: v.readiness });
    } catch (e) {
      $("voice-loading-message").textContent =
        `设置未载入：${e.message}。如果刚更新程序，请退出旧宠物后台并重新启动，然后点击重新载入。`;
      throw e;
    } finally {
      loading = false;
    }
  }
  $("voice-retry").onclick = run(load);
  $("voice-mode").onchange = visibility;
  $("voice-continuous").onchange = visibility;
  $("voice-sensitivity").oninput = visibility;
  $("voice-pet-default").onclick = run(async () => {
    $("voice-identity").value = "persona";
    $("voice-mode").value = "chained";
    $("voice-tts-kind").value = "openrouter";
    $("voice-tts-baseUrl").value = "https://openrouter.ai/api/v1";
    $("voice-tts-model").value = "fish-audio/s2.1-pro";
    $("voice-tts-voice").value = "";
    $("voice-reference").checked = true;
    visibility();
    await save();
    toast("已选择原创宠物声线；OpenRouter 合成密钥可继续使用");
  });
  $("voice-save").onclick = run(async () => {
    await save();
    toast("语音设置已保存");
  });
  $("media-save").onclick = run(async () => {
    await api.request("media.set", {
      screenEnabled: $("media-enabled").checked,
      autoScreen: $("media-auto").checked,
      displayId: $("media-display").value,
    });
    toast("图片设置已保存");
  });
  for (const slot of ["stt", "tts", "live"]) {
    const p = "voice-" + slot + "-";
    $(p + "kind").onchange = () => {
      const kind = $(p + "kind").value;
      $(p + "baseUrl").value =
        kind === "openrouter"
          ? "https://openrouter.ai/api/v1"
          : kind === "gemini"
            ? "https://generativelanguage.googleapis.com/v1beta"
            : "https://api.openai.com/v1";
      $(p + "model").value =
        kind === "system"
          ? "windows"
          : kind === "openrouter"
            ? slot === "stt"
              ? "qwen/qwen3-asr-1.7b"
              : $("voice-identity").value !== "provider"
                ? "fish-audio/s2.1-pro"
                : "qwen/qwen-audio-3.0-tts-flash"
            : slot === "stt"
              ? "gpt-4o-mini-transcribe"
              : slot === "tts"
                ? "gpt-4o-mini-tts"
                : kind === "gemini"
                  ? ""
                  : "gpt-realtime";
      if (slot !== "stt")
        $(p + "voice").value =
          kind === "openrouter"
            ? "longanhuan_v3.6"
            : kind === "system"
              ? ""
              : kind === "gemini"
                ? "Aoede"
                : "coral";
      $(p + "models").replaceChildren();
      if (slot !== "stt") $(p + "voices").replaceChildren();
      $(p + "key-state").textContent = "保存后检查此地址的密钥";
    };
    $(p + "save-key").onclick = run(async () => {
      const key = $(p + "key").value.trim();
      if (!key) throw new Error("请先填入此接口的密钥");
      await save();
      await api.request("voice.key", { slot, key });
      $(p + "key").value = "";
      $(p + "key-state").textContent = "已加密保存";
      toast("密钥已保存，仅用于这个语音接口");
    });
    $(p + "catalog").onclick = run(async () => {
      const c = await api.request("voice.catalog", { slot, settings: read() });
      $(p + "models").replaceChildren(
        ...c.models.map((m) => new Option(m.name, m.id)),
      );
      if (slot !== "stt")
        $(p + "voices").replaceChildren(
          ...c.voices.map((v) => new Option(v.name, v.id)),
        );
      $(p + "note").textContent = `${c.models.length} 个模型 · ${c.note}`;
      toast("已获取目录，可在模型和音色输入框中选择");
    });
  }
  for (const method of ["start", "stop", "test", "wake-test"])
    $("voice-" + method).onclick = run(async () => {
      if (method !== "stop") await save();
      await api.request("voice." + method);
      status(await api.request("voice.state"));
    });
  $("voice-cache").onclick = run(async () => {
    await save();
    const c = await api.request("voice.cache");
    $("voice-cache-state").textContent =
      `${c.files} 个缓存文件 · ${(c.bytes / 1048576).toFixed(1)} MB`;
  });
  return {
    activate(id) {
      clearInterval(poll);
      if (id !== "voice") return;
      void load().catch((e) => toast(e.message, true));
      poll = setInterval(
        () =>
          api
            .request("voice.state")
            .then(status)
            .catch(() => {}),
        800,
      );
    },
  };
}

export function createIntegrationSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  $("integrations").innerHTML = `
    <div class="group"><div class="service-head"><div><h3>飞书</h3><p>把宠物带进飞书私聊，也可以让它处理文档、日程和任务。</p></div><span class="chip" id="feishu-state">尚未连接</span></div>
      <div class="panel panel-form" style="margin-top:12px">
        <div class="button-row"><button id="feishu-login" class="primary">登录飞书或扫码接入</button><button id="feishu-check" class="quiet">检查登录</button><button id="feishu-install" class="quiet">安装飞书依赖</button></div>
        <small id="feishu-dependency">依赖只在点击后下载，安装到宠物目录。</small>
        <div id="feishu-job" hidden><b id="feishu-job-title"></b><pre id="feishu-job-output" class="code-block"></pre><div class="button-row"><button id="feishu-open" class="primary">打开官方登录页面</button><button id="feishu-cancel" class="quiet">取消当前操作</button></div></div>
        <details><summary>使用已有的机器人</summary><div class="panel-form"><div class="field-grid"><label class="field">App ID<input id="feishu-app-id" placeholder="cli_…" autocomplete="off" spellcheck="false"></label><label class="field">App Secret<input id="feishu-app-secret" type="password" autocomplete="off" placeholder="只交给飞书 CLI 的凭据存储"></label></div><div class="button-row"><button id="feishu-configure" class="quiet">连接已有机器人</button></div><small>需要在飞书开发者后台启用机器人和长连接事件 im.message.receive_v1，授予消息收发权限并发布应用。</small></div></details>
      </div></div>
    <div class="group"><h3>飞书办公能力</h3><div class="panel">
      <label class="row-setting"><div class="row-text"><b>启用飞书办公工具</b><small>默认允许读取、创建、修改和删除业务内容。账户、凭据和组织管理不开放。</small></div><input id="feishu-office" type="checkbox" role="switch"></label>
      <label class="row-setting"><div class="row-text"><b>以谁的身份操作</b><small>机器人只能访问应用可用的资源。</small></div><select id="feishu-identity"><option value="user">我自己（需要登录授权）</option><option value="bot">机器人</option></select></label>
      <div class="row-setting"><div class="row-text"><b>授权完整的办公读写</b><small>在官方页面一次授权所有业务能力，不申请应用或组织管理权限。已登录的账户需要重新授权才能增加能力。</small></div><button id="feishu-authorize-office" class="quiet">去授权</button></div>
      <div class="panel-form"><details><summary>自定义授权范围</summary><div class="panel-form"><label class="field">Scope（多个用空格分隔，多次授权会累积）<textarea id="feishu-scopes" rows="2" placeholder="需要单独补充的 scope" spellcheck="false"></textarea></label><div class="button-row"><button id="feishu-authorize" class="quiet">按填写的范围授权</button></div></div></details>
      <div id="feishu-access" hidden><b>还需要补充的授权</b><small>这里列出工具实际遇到的缺失权限。授权后重试对应操作，成功后提示会自动消失。</small><div id="feishu-access-list" class="list" style="gap:8px;margin-top:8px"></div></div></div>
    </div></div>
    <div class="group"><h3>在飞书里聊天</h3><div class="panel">
      <label class="row-setting"><div class="row-text"><b>启用私聊</b><small>宠物运行时保持连接。回复显示在飞书里，桌面上不会重复弹气泡。</small></div><input id="feishu-channel" type="checkbox" role="switch"></label>
      <div class="row-setting"><div class="row-text"><b>配对</b><small>先保存并启用私聊，再把配对码发给机器人。配对码 5 分钟内有效；发送 /new 开始新对话。</small></div><div class="button-row"><b id="feishu-pair-code" class="pair-code"></b><button id="feishu-pair" class="quiet">生成配对码</button></div></div>
      <div class="panel-form"><details><summary>已允许的用户</summary><label class="field">用户 open_id（每行一个；移除后不再接受这个人的任务）<textarea id="feishu-users" rows="3" placeholder="ou_…" spellcheck="false"></textarea><small id="feishu-last-sender"></small></label></details>
      <div class="button-row"><small id="feishu-error" style="flex:1"></small><button id="feishu-save" class="primary">保存飞书设置</button></div></div>
    </div></div>
    <div class="group"><div class="service-head"><div><h3>GitHub</h3><p>查询仓库、Issue 和 Pull Request，按你的授权处理开发任务。</p></div><span class="chip" id="github-state">尚未连接</span></div>
      <div class="panel panel-form" style="margin-top:12px">
        <label class="field">登录方式<select id="github-auth"><option value="browser">浏览器登录（推荐）</option><option value="token">Personal Access Token</option></select></label>
        <div id="github-browser" class="panel-form" style="padding:0"><div class="button-row"><button id="github-login" class="primary">登录 GitHub</button><button id="github-install" class="quiet">安装登录依赖</button></div><small>通过官方 GitHub CLI 在浏览器中授权，不需要自己创建 OAuth 应用。</small></div>
        <label id="github-token-row" class="field" hidden>Token<input id="github-token" type="password" autocomplete="off" placeholder="留空则保留已保存的 Token"><small>使用你在 GitHub 创建的 Token，权限范围由你决定，加密保存。</small></label>
        <div id="github-job" hidden><b id="github-job-title"></b><pre id="github-job-output" class="code-block"></pre><div class="button-row"><button id="github-open" class="primary">打开 GitHub 授权页面</button><button id="github-cancel" class="quiet">取消当前操作</button></div></div>
      </div>
      <div class="panel" style="margin-top:12px">
        <label class="row-setting"><div class="row-text"><b>启用 GitHub 工具</b><small id="github-key-state">登录后连接官方 MCP 服务。</small></div><input id="github-enabled" type="checkbox" role="switch"></label>
        <label class="row-setting"><div class="row-text"><b>只读模式</b><small>默认开放代码、仓库、Issue、PR 等业务读写；账户、凭据、组织和安全设置不开放。</small></div><input id="github-readonly" type="checkbox" role="switch"></label>
        <div class="panel-form"><div class="button-row"><small id="github-error" style="flex:1"></small><button id="github-connect" class="quiet">连接并刷新工具</button><button id="github-save" class="primary">保存 GitHub 设置</button></div></div>
      </div></div>`;
  let active = false,
    polling = false,
    first = true,
    feishuDirty = false,
    githubDirty = false;
  [
    "feishu-office",
    "feishu-channel",
    "feishu-identity",
    "feishu-users",
  ].forEach((id) =>
    $(id).addEventListener("input", () => {
      feishuDirty = true;
    }),
  );
  ["github-auth", "github-token", "github-enabled", "github-readonly"].forEach(
    (id) =>
      $(id).addEventListener("input", () => {
        githubDirty = true;
      }),
  );
  function authMode() {
    $("github-browser").hidden = $("github-auth").value !== "browser";
    $("github-token-row").hidden = $("github-auth").value !== "token";
  }
  $("github-auth").onchange = authMode;
  function job(kind, value) {
    $(kind + "-job").hidden = !value;
    if (!value) return;
    $(kind + "-job-title").textContent =
      value.kind +
      (value.running ? "：进行中" : value.error ? "：未完成" : "：已完成");
    $(kind + "-job-output").textContent =
      value.output + (value.error ? "\n" + value.error : "");
    $(kind + "-open").hidden = !value.url;
    $(kind + "-cancel").hidden = !value.running;
  }
  function chip(id, text, ok) {
    $(id).textContent = text;
    $(id).className = "chip" + (ok ? " ok" : "");
  }
  let accessState = "";
  function access(f) {
    const issues = f.accessIssues ?? [];
    const state = JSON.stringify([issues, !!f.job?.running, f.config.identity]);
    if (state === accessState) return;
    accessState = state;
    $("feishu-access").hidden = !issues.length;
    $("feishu-access-list").replaceChildren();
    for (const issue of issues) {
      const item = document.createElement("div"),
        title = document.createElement("b"),
        scopes = document.createElement("code");
      item.className = "access-item";
      title.textContent = `${issue.command}（${issue.identity === "user" ? "用户" : "机器人"}）`;
      scopes.textContent = issue.scopes.join(" ");
      item.append(title, scopes);
      if (issue.identity === "user") {
        const button = document.createElement("button");
        button.className = "quiet";
        button.style.alignSelf = "flex-start";
        button.textContent = "补充这项授权";
        button.disabled = !!f.job?.running || f.config.identity !== "user";
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api.request("feishu.authorize", {
              scope: issue.scopes.join(" "),
            });
            await refresh();
          } catch (e) {
            toast(e.message, true);
          } finally {
            accessState = "";
            await refresh();
          }
        };
        item.append(button);
      } else {
        const hint = document.createElement("small");
        hint.textContent =
          "请在飞书开发者后台为应用开通这些权限；机器人不使用用户登录授权。";
        item.append(hint);
      }
      $("feishu-access-list").append(item);
    }
  }
  async function refresh(force = "") {
    if (polling) return;
    polling = true;
    try {
      const { feishu: f, github: g } = await api.request("integrations.status");
      chip("feishu-state", f.channel, f.channel === "已连接");
      $("feishu-error").textContent = f.error ?? "";
      $("feishu-authorize-office").disabled =
        f.config.identity === "bot" || !!f.job?.running;
      $("feishu-dependency").textContent = f.installed
        ? `飞书 CLI v${f.version} 已安装在 ${f.root}`
        : "依赖只在点击后下载，安装到宠物目录，不需要另外安装 Node.js。";
      $("feishu-install").textContent = f.installed
        ? "重新安装飞书依赖"
        : "安装飞书依赖";
      $("feishu-pair-code").textContent = f.pairing
        ? `/pair ${f.pairing.code}`
        : "";
      $("feishu-last-sender").textContent = f.lastSender
        ? `最近发来消息的用户：${f.lastSender}`
        : "";
      if (first || force === "feishu" || !feishuDirty) {
        $("feishu-office").checked = f.config.officeEnabled;
        $("feishu-channel").checked = f.config.channelEnabled;
        $("feishu-identity").value = f.config.identity;
        $("feishu-users").value = f.config.allowedUsers.join("\n");
      }
      chip(
        "github-state",
        g.connected
          ? `已连接 ${g.tools} 个工具`
          : g.enabled
            ? "等待连接"
            : "未启用",
        g.connected,
      );
      $("github-error").textContent = g.error ?? "";
      $("github-key-state").textContent = g.hasKey
        ? "已保存凭据，连接官方 MCP 服务。"
        : "登录或填写 Token 后保存设置。";
      $("github-install").textContent = g.installed
        ? "重新安装登录依赖"
        : "安装登录依赖";
      if (first || force === "github" || !githubDirty) {
        $("github-auth").value = g.authMode;
        $("github-enabled").checked = g.enabled;
        $("github-readonly").checked = g.readOnly;
        authMode();
      }
      job("feishu", f.job);
      access(f);
      job("github", g.job);
      first = false;
    } catch (e) {
      if (first) toast(e.message, true);
    } finally {
      polling = false;
    }
  }
  function action(id, method, params, after) {
    $(id).onclick = async () => {
      $(id).disabled = true;
      try {
        await api.request(
          method,
          typeof params === "function" ? params() : params,
        );
        if (after) await after();
        await refresh();
      } catch (e) {
        toast(e.message, true);
      } finally {
        $(id).disabled = false;
      }
    };
  }
  for (const kind of ["feishu", "github"]) {
    action(kind + "-install", kind + ".install");
    action(kind + "-cancel", kind + ".cancel");
    action(kind + "-open", kind + ".openAuthorization");
  }
  action("feishu-login", "feishu.createApp");
  action("feishu-check", "feishu.check");
  action("feishu-authorize", "feishu.authorize", () => ({
    scope: $("feishu-scopes").value.trim(),
  }));
  action("feishu-authorize-office", "feishu.authorizeOffice");
  action(
    "feishu-configure",
    "feishu.configure",
    () => ({
      appId: $("feishu-app-id").value.trim(),
      appSecret: $("feishu-app-secret").value,
    }),
    () => {
      $("feishu-app-secret").value = "";
    },
  );
  action("feishu-pair", "feishu.pair");
  action(
    "feishu-save",
    "feishu.save",
    () => ({
      officeEnabled: $("feishu-office").checked,
      channelEnabled: $("feishu-channel").checked,
      identity: $("feishu-identity").value,
      allowedUsers: $("feishu-users").value.split(/\s+/).filter(Boolean),
    }),
    () => {
      feishuDirty = false;
      toast("飞书设置已保存");
    },
  );
  action("github-login", "github.login");
  action(
    "github-save",
    "github.save",
    () => ({
      enabled: $("github-enabled").checked,
      readOnly: $("github-readonly").checked,
      authMode: $("github-auth").value,
      ...($("github-token").value.trim()
        ? { token: $("github-token").value.trim() }
        : {}),
    }),
    () => {
      githubDirty = false;
      $("github-token").value = "";
      toast("GitHub 设置已保存");
    },
  );
  action("github-connect", "github.connect");
  setInterval(() => {
    if (active && !document.hidden) void refresh();
  }, 2000);
  return {
    activate(page) {
      active = page === "integrations";
      if (active) void refresh();
    },
  };
}

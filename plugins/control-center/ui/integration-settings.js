export function createIntegrationSettings(api, toast) {
  const $ = (id) => document.getElementById(id),
    nav = document.querySelector("nav");
  const button = document.createElement("button");
  button.dataset.page = "integrations";
  button.textContent = "↗  飞书与 GitHub";
  nav.insertBefore(button, nav.lastElementChild);
  const host = document.createElement("section");
  host.id = "integrations";
  host.className = "page";
  host.hidden = true;
  host.innerHTML = `
    <div class="card form"><div class="integration-heading"><div><h3>飞书</h3><p>把宠物带进私聊，也让它帮你处理文档、日程和任务。</p></div><span class="pill" id="feishu-state">尚未连接</span></div>
      <div class="row"><button id="feishu-install" class="ghost">安装飞书依赖</button><button id="feishu-login" class="primary">登录飞书 / 扫码接入</button><button id="feishu-check" class="ghost">检查登录</button></div>
      <small id="feishu-dependency">依赖只在点击后下载，安装到宠物目录。</small>
      <div id="feishu-job" hidden><b id="feishu-job-title"></b><pre id="feishu-job-output" class="integration-log"></pre><div class="row"><button id="feishu-open" class="primary">打开官方登录页面</button><button id="feishu-cancel" class="ghost">取消当前操作</button></div></div>
      <details><summary>使用已有机器人</summary><label>App ID<input id="feishu-app-id" placeholder="cli_…" autocomplete="off"></label><label>App Secret<input id="feishu-app-secret" type="password" autocomplete="off" placeholder="只交给飞书 CLI 的凭据存储"></label><button id="feishu-configure" class="ghost">连接已有机器人</button><small>需在飞书开发者后台启用机器人和长连接事件 im.message.receive_v1，并授予消息收发权限、发布应用。</small></details>
      <div class="section-title"><h3>办公能力</h3></div>
      <label class="setting"><div><b>启用飞书办公工具</b><small>默认允许读取、创建、修改和删除业务内容；账户、凭据和组织管理不开放。</small></div><input id="feishu-office" type="checkbox" role="switch"></label>
      <label>以谁的身份操作<select id="feishu-identity"><option value="user">我自己（需要用户登录授权）</option><option value="bot">机器人（仅访问应用可用资源）</option></select></label>
      <button id="feishu-authorize-office" class="primary">授权完整办公读写能力</button>
      <small>通过官方页面一次授权业务域；不申请应用或组织管理域。已有账户需要重新授权才能增加能力。</small>
      <details><summary>自定义授权范围</summary><label>Scope（多个用空格分隔，后续授权可累积）<textarea id="feishu-scopes" rows="2" placeholder="需要单独补充的 scope"></textarea></label><button id="feishu-authorize" class="ghost">按填写的范围授权</button><small>也可使用下方缺失权限提示，按需补充。</small></details>
      <div id="feishu-access" hidden><h4>待补充的授权</h4><small>这里列出工具实际遇到的缺失权限；完成授权后再重试对应操作，成功后自动移除提示。</small><div id="feishu-access-list"></div></div>
      <div class="section-title"><h3>在飞书里聊天</h3></div>
      <label class="setting"><div><b>启用私聊通道</b><small>宠物运行时保持连接。文字回复在飞书显示；桌面气泡不会重复出现。</small></div><input id="feishu-channel" type="checkbox" role="switch"></label>
      <div class="row"><button id="feishu-pair" class="ghost">生成配对码</button><b id="feishu-pair-code"></b></div><small>先保存并启用通道，再在机器人私聊中发送配对指令；配对码 5 分钟有效。发送 /new 开始新对话。</small>
      <details><summary>已允许的用户</summary><label>用户 open_id（每行一项；移除后不再接受其任务）<textarea id="feishu-users" rows="3" placeholder="ou_…"></textarea></label><small id="feishu-last-sender"></small></details>
      <div class="row"><small id="feishu-error"></small><button id="feishu-save" class="primary">保存飞书设置</button></div>
    </div>
    <div class="card form"><div class="integration-heading"><div><h3>GitHub</h3><p>查询仓库、Issue、Pull Request，按你的授权处理开发任务。</p></div><span class="pill" id="github-state">尚未连接</span></div>
      <label>登录方式<select id="github-auth"><option value="browser">浏览器登录（推荐）</option><option value="token">Personal Access Token</option></select></label>
      <div id="github-browser"><div class="row"><button id="github-install" class="ghost">安装登录依赖</button><button id="github-login" class="primary">登录 GitHub</button></div><small>通过官方 GitHub CLI 打开浏览器授权；不需要自己创建 OAuth 应用。</small></div>
      <div id="github-token-row" hidden><label>Token<input id="github-token" type="password" autocomplete="off" placeholder="留空保留已经保存的 Token"></label><small>使用 GitHub 创建的 Token，权限范围由你控制，密钥加密保存。</small></div>
      <div id="github-job" hidden><b id="github-job-title"></b><pre id="github-job-output" class="integration-log"></pre><div class="row"><button id="github-open" class="primary">打开 GitHub 授权页面</button><button id="github-cancel" class="ghost">取消当前操作</button></div></div>
      <label class="setting"><div><b>启用 GitHub 工具</b><small id="github-key-state">登录后连接官方 MCP 服务。</small></div><input id="github-enabled" type="checkbox" role="switch"></label>
      <label class="setting"><div><b>只读模式（可选）</b><small>默认开放代码、仓库、Issue、PR 等业务读写；账户、凭据、组织和安全设置不开放。</small></div><input id="github-readonly" type="checkbox" role="switch"></label>
      <div class="row"><button id="github-save" class="primary">保存 GitHub 设置</button><button id="github-connect" class="ghost">连接并刷新工具</button></div><small id="github-error"></small>
    </div>`;
  document.querySelector("main").insertBefore(host, $("toast"));
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
      (value.running ? " · 进行中" : value.error ? " · 未完成" : " · 完成");
    $(kind + "-job-output").textContent =
      value.output + (value.error ? "\n" + value.error : "");
    $(kind + "-open").hidden = !value.url;
    $(kind + "-cancel").hidden = !value.running;
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
        title = document.createElement("p"),
        scopes = document.createElement("code");
      title.textContent = `${issue.command} · ${issue.identity === "user" ? "用户" : "机器人"}`;
      scopes.textContent = issue.scopes.join(" ");
      item.append(title, scopes);
      if (issue.identity === "user") {
        const row = document.createElement("div"),
          button = document.createElement("button");
        row.className = "row";
        button.className = "ghost";
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
        row.append(button);
        item.append(row);
      } else {
        const hint = document.createElement("p");
        hint.textContent =
          "请在飞书开发者后台为应用开通上述权限；机器人不使用用户登录授权。";
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
      $("feishu-state").textContent = f.channel;
      $("feishu-error").textContent = f.error ?? "";
      $("feishu-authorize-office").disabled =
        f.config.identity === "bot" || !!f.job?.running;
      $("feishu-dependency").textContent = f.installed
        ? `CLI v${f.version} 已安装 · ${f.root}`
        : "依赖只在点击后下载，安装到宠物目录，无需单独安装 Node.js。";
      $("feishu-install").textContent = f.installed
        ? "重新安装飞书依赖"
        : "安装飞书依赖";
      $("feishu-pair-code").textContent = f.pairing
        ? `/pair ${f.pairing.code}`
        : "";
      $("feishu-last-sender").textContent = f.lastSender
        ? `最近收到消息的用户：${f.lastSender}`
        : "";
      if (first || force === "feishu" || !feishuDirty) {
        $("feishu-office").checked = f.config.officeEnabled;
        $("feishu-channel").checked = f.config.channelEnabled;
        $("feishu-identity").value = f.config.identity;
        $("feishu-users").value = f.config.allowedUsers.join("\n");
      }
      $("github-state").textContent = g.connected
        ? `已连接 · ${g.tools} 个工具`
        : g.enabled
          ? "等待连接"
          : "未启用";
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

# Agent setup guide

This file is for a coding agent (Claude Code, Codex, Cursor, Pi or a similar tool) that installs FreeTier Router for a person. The agent does every step. The person does one thing: they add their provider keys in the dashboard.

To use it, tell your agent: "Set up FreeTier Router by following AGENT-SETUP.md in https://github.com/viraj-s15/freetier-router."

## Rules for the agent

- Never print a secret to the chat: not the `ENCRYPTION_KEY`, the admin password, the unified key or a provider key. Write secrets only to the files that this guide names, with mode `0600`.
- Never ask the person for provider keys in the chat. They add the keys in the dashboard.
- Ask before you install system packages, or before you add a login service.
- If a step fails, stop and show the person the error and the log path. Don't try other install methods without asking.

## Values

Use these defaults unless the person gives other values.

| Name | Default |
| --- | --- |
| `INSTALL_DIR` | `~/freetier-router` |
| `PORT` | `3001` |
| `CONF_DIR` | `~/.config/freetier-router` |
| Admin email | `admin@freetier.local` |

## Steps

### 1. Check the prerequisites

1. Make sure that `git` is installed.
2. Find a Node.js binary with major version 20, 22 or 24. Node 25 and later aren't supported, because of the `better-sqlite3` native module. Node 22 is the version that the repo pins in `.nvmrc`.
   - Check `node --version` first.
   - If that version isn't supported, look for `/opt/homebrew/opt/node@22/bin/node`, `/usr/local/opt/node@22/bin/node` or an nvm install (`~/.nvm/versions/node/v22*/bin/node`).
   - If no supported version exists, ask the person, then install Node 22 (`brew install node@22` on macOS, or `nvm install 22`).
3. Save the full path of that binary as `NODE`, and save the `npm` next to it as `NPM`. Use these two paths for every later step, because the module is built for the Node version that runs `npm ci`.

### 2. Get the code and build it

```bash
git clone https://github.com/viraj-s15/freetier-router.git "$INSTALL_DIR"
cd "$INSTALL_DIR"
PATH="$(dirname "$NODE"):$PATH" "$NPM" ci
PATH="$(dirname "$NODE"):$PATH" "$NPM" run build
```

If `INSTALL_DIR` already has a clone, run `git pull` in it and build again. Don't clone a second copy.

### 3. Write the `.env` file

The server reads `.env` from the repo root. `ENCRYPTION_KEY` encrypts the stored provider keys. If this key is lost, the stored keys can't be read, so never replace the key in an existing `.env`.

```bash
cd "$INSTALL_DIR"
if [ ! -f .env ]; then
  umask 077
  KEY="$("$NODE" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  printf "ENCRYPTION_KEY=%s\nPORT=%s\nHOST=127.0.0.1\n" "$KEY" "$PORT" > .env
  unset KEY
fi
```

`HOST=127.0.0.1` keeps the router on this computer only. If the person wants other devices on the network to use it, ask them first. Then remove the `HOST` line, and read "First-run setup" in `.env.example`.

### 4. Start the router

Run it once in the background to check that it starts:

```bash
cd "$INSTALL_DIR"
mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
nohup "$NODE" server/dist/index.js > "$CONF_DIR/router.log" 2>&1 &
echo $! > "$CONF_DIR/router.pid"
```

Wait until `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/v1/models` gives a number other than `000`. This takes about 1 to 5 seconds. If it doesn't happen within 30 seconds, read `$CONF_DIR/router.log`. A `NODE_MODULE_VERSION` error means that `npm ci` ran with another Node version, so do step 2 again with `NODE`.

### 5. Create the admin account

The first account can be created from this computer with no code. Make a random password, create the account, and save both values:

```bash
EMAIL="admin@freetier.local"
PASS="$("$NODE" -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
curl -s -X POST "http://127.0.0.1:$PORT/api/auth/setup" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" > "$CONF_DIR/setup.json"
TOKEN="$("$NODE" -e 'const j=require(process.argv[1]);process.stdout.write(j.token??"")' "$CONF_DIR/setup.json")"
```

- If the reply has a `token`, the account exists. Write `EMAIL` and `PASS` to `$CONF_DIR/dashboard-login` with mode `0600`.
- If the reply has `setup_complete`, an account exists already. Ask the person for the login, or use `$CONF_DIR/dashboard-login` from an earlier install.

Delete `$CONF_DIR/setup.json` after you read the token from it.

### 6. Save the unified key

Client apps use the unified key for the `/v1` API. Read it with the session token, and save it without showing it:

```bash
umask 077
curl -s "http://127.0.0.1:$PORT/api/settings/api-key" -H "Authorization: Bearer $TOKEN" \
  | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).apiKey))' \
  > "$CONF_DIR/api-key"
```

If the session token has expired, get a new one with `POST /api/auth/login` and the same JSON body as step 5.

### 7. Keep the router running after a reboot

Ask the person which option they want. A source run stops at reboot.

- macOS: a LaunchAgent. Write `~/Library/LaunchAgents/com.freetier-router.plist`, then run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.freetier-router.plist`.

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>Label</key><string>com.freetier-router</string>
    <key>ProgramArguments</key>
    <array><string>NODE</string><string>INSTALL_DIR/server/dist/index.js</string></array>
    <key>WorkingDirectory</key><string>INSTALL_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>CONF_DIR/router.log</string>
    <key>StandardErrorPath</key><string>CONF_DIR/router.log</string>
  </dict>
  </plist>
  ```

  Replace `NODE`, `INSTALL_DIR` and `CONF_DIR` with full paths, because launchd doesn't expand `~` or variables. Stop the background process from step 4 first (`kill "$(cat "$CONF_DIR/router.pid")"`), so that the two don't fight for the port.

- Linux: a systemd user service in `~/.config/systemd/user/freetier-router.service`, then `systemctl --user enable --now freetier-router`.

  ```ini
  [Unit]
  Description=FreeTier Router

  [Service]
  WorkingDirectory=INSTALL_DIR
  ExecStart=NODE INSTALL_DIR/server/dist/index.js
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

  Stop the background process from step 4 first. To keep the service running when the person isn't logged in, they can run `loginctl enable-linger`.

- Docker: run `docker compose up -d --build` in `INSTALL_DIR`. The compose file restarts the container. Docker uses its own data volume, so do steps 5 and 6 again against the container.

- None: the person starts the router by hand with `"$NODE" server/dist/index.js` in `INSTALL_DIR`.

### 8. Hand over to the person

Tell the person:

1. Open http://127.0.0.1:PORT and sign in with the login in `CONF_DIR/dashboard-login`.
2. On the **Keys** page, add a key for one or more free providers. Groq, Google AI Studio and OpenRouter have free tiers and are quick to sign up for.
3. Tell the agent when the keys are in.

Don't continue until the person says that the keys are in.

### 9. Check that it works

```bash
KEY="$(cat "$CONF_DIR/api-key")"
curl -s "http://127.0.0.1:$PORT/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","max_tokens":50,"messages":[{"role":"user","content":"Reply with only the word: pong"}]}'
```

- A reply with `choices[0].message.content` means that it works. The `model` field names the model that answered.
- `no_providers_configured` means that no provider key is in. Go back to step 8.
- A `401` means that the unified key is wrong. Do step 6 again.
- A `429` means that the free models are rate-limited. Wait a minute and try again.

### 10. Connect the person's tools

Any OpenAI-compatible client works with these settings:

- Base URL: `http://127.0.0.1:PORT/v1`
- API key: the contents of `CONF_DIR/api-key`
- Model: `auto`, or an id from `GET /v1/models`

For the OpenAI SDKs, set `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Give clients a timeout of at least 120 seconds, because free models can be slow. Ask the person which tools to connect, and put the key in each tool's own secret store, not in a shell profile that other tools can read.

## Notes for the person

- Free providers can log your inputs and train on them. Don't send secrets or private data through the router.
- Models that discovery adds aren't tested by hand. If a model fails every time, turn it off on the **Models** page.
- To remove everything, stop the service, then delete `INSTALL_DIR` and `CONF_DIR`. The data is in `INSTALL_DIR/server/data`.

# Using Sidekick with Microsoft Foundry Local

[Microsoft Foundry Local](https://github.com/microsoft/Foundry-Local) runs AI models entirely on your device and exposes an OpenAI-compatible API. Sidekick can connect to it with no API key required.

## Prerequisites

- Windows (Foundry Local is Windows-only as of this writing)
- A supported GPU/CPU; CUDA GPU recommended for Phi-4
- Foundry Local CLI installed: follow the [official install guide](https://github.com/microsoft/Foundry-Local)
- Sidekick plugin installed and configured

---

## Step 1 — Start the Foundry Local service

The Foundry Local background service must be running before Sidekick can connect.

```powershell
foundry service start
```

Verify it started and get the active port:

```powershell
foundry service status
```

Example output:

```
🟢 Model management service is running on http://127.0.0.1:59422/openai/status
```

> **Note:** The port number is dynamic and changes each time the service restarts. Always run `foundry service status` to get the current port.

---

## Step 2 — Load a model into the service

Use `foundry model load` (not `foundry model run`) to make a model available via the API.

```powershell
foundry model load Phi-4-cuda-gpu:1
```

To list all available models and their aliases:

```powershell
foundry model list
```

Common models and their aliases:

| Alias | Recommended model ID |
|-------|---------------------|
| `phi-4` | `Phi-4-cuda-gpu:1` (GPU) / `Phi-4-generic-cpu:1` (CPU) |
| `phi-3.5-mini` | `Phi-3.5-mini-instruct-cuda-gpu:1` |
| `phi-4-mini-reasoning` | `Phi-4-mini-reasoning-cuda-gpu:3` |

Verify the model is loaded:

```powershell
foundry service status
```

A loaded model will appear in the output instead of "No models are currently loaded in the service".

> **Tip:** `foundry model run` is an interactive CLI chat session — it does **not** load a model into the API service.

---

## Step 3 — Configure Sidekick

Open Obsidian **Settings → Sidekick → Models** and set:

| Setting | Value |
|---------|-------|
| **Provider** | Microsoft Foundry Local |
| **Base URL** | `http://127.0.0.1:<PORT>/v1` |
| **Model name** | The full Model ID, e.g. `Phi-4-cuda-gpu:1` |
| **API key** | *(leave empty — not required)* |
| **Bearer token** | *(leave empty — not required)* |
| **Wire API** | Completions |

Replace `<PORT>` with the port shown by `foundry service status` (e.g. `59422`).

**Example Base URL:** `http://127.0.0.1:59422/v1`

Click **Test** to verify. You should see a "Provider session created successfully." notice.

> **Note:** Streaming is automatically disabled when the **Microsoft Foundry Local** provider is selected — this is expected.

---

## Step 4 — Start chatting

After a successful test, select the model from the Sidekick chat dropdown and start a session. Inference runs entirely on your device.

---

## Keeping the service running

By default, unloaded models are evicted after 10 minutes (TTL = 600 seconds). To keep a model loaded indefinitely during a session:

```powershell
foundry model load --ttl 0 Phi-4-cuda-gpu:1
```

To unload a model and free GPU memory:

```powershell
foundry model unload Phi-4-cuda-gpu:1
```

---

## Troubleshooting

### "Provider session created successfully" but no response in chat

- Confirm the model is loaded: `foundry service status`
- The model may have been evicted (TTL expired). Re-run `foundry model load`.

### Connection refused / cannot connect

- The service may have restarted and the port changed. Re-check with `foundry service status` and update **Base URL** in settings.
- Run `foundry service start` if the service is stopped.

### Wrong model name

- Use the exact **Model ID** from `foundry model list` (e.g. `Phi-4-cuda-gpu:1`), **not** the alias (`phi-4`).
- Sidekick passes the model name as-is to the API, so it must exactly match what the Foundry Local `/v1/models` endpoint exposes.

### Model fails to load (out of memory)

- Choose a smaller model or a CPU variant (e.g. `Phi-4-generic-cpu:1`).
- Close other GPU-intensive applications before loading.

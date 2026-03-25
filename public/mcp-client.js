/**
 * Client MCP HTTP Streamable pour geocontext.
 *
 * Implémente le protocole MCP Streamable HTTP :
 *   - POST /mcp avec JSON-RPC 2.0
 *   - Header mcp-session-id pour la persistance de session
 *   - Gestion SSE pour les réponses streamées
 *
 * Usage :
 *   const client = new McpClient("/mcp");
 *   await client.initialize();
 *   const tools = await client.listTools();
 *   const result = await client.callTool("navigate", { target: "25349" });
 */

class McpClient {
  constructor(endpoint = "/mcp") {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.requestId = 0;
    this.connected = false;
    this.onToolsChanged = null; // callback
  }

  /** Génère un ID de requête JSON-RPC unique. */
  _nextId() {
    return ++this.requestId;
  }

  /**
   * Envoie une requête JSON-RPC au serveur MCP.
   * Gère le header mcp-session-id et le parsing SSE.
   */
  async _request(method, params = {}) {
    const id = this._nextId();
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    // Capturer le session ID
    const sid = response.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    const contentType = response.headers.get("content-type") || "";

    // Réponse JSON directe
    if (contentType.includes("application/json")) {
      const json = await response.json();
      if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
      }
      return json.result;
    }

    // Réponse SSE — parser les événements
    if (contentType.includes("text/event-stream")) {
      return this._parseSSE(response, id);
    }

    throw new Error(`Unexpected content-type: ${contentType}`);
  }

  /**
   * Parse un flux SSE et retourne le résultat de la requête.
   * Gère aussi les notifications (tools/list_changed).
   */
  async _parseSSE(response, expectedId) {
    const text = await response.text();
    const events = text.split("\n\n").filter(Boolean);
    let result = null;

    for (const event of events) {
      const lines = event.split("\n");
      let data = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          data += line.slice(6);
        }
      }
      if (!data) continue;

      try {
        const msg = JSON.parse(data);

        // Notification (pas de id)
        if (!msg.id && msg.method) {
          this._handleNotification(msg);
          continue;
        }

        // Réponse à notre requête
        if (msg.id === expectedId) {
          if (msg.error) {
            throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
          }
          result = msg.result;
        }
      } catch (e) {
        if (e.message.startsWith("MCP error")) throw e;
        // Ignorer les lignes non-JSON
      }
    }

    return result;
  }

  /** Traite les notifications MCP. */
  _handleNotification(msg) {
    if (msg.method === "notifications/tools/list_changed") {
      if (this.onToolsChanged) this.onToolsChanged();
    }
  }

  // ================================================================
  // API publique
  // ================================================================

  /** Initialise la session MCP. */
  async initialize() {
    const result = await this._request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "geocontext-web", version: "1.0.0" },
    });
    this.connected = true;

    // Envoyer la notification initialized
    await this._notify("notifications/initialized");

    return result;
  }

  /** Envoie une notification (sans attendre de réponse). */
  async _notify(method, params = {}) {
    const headers = {
      "Content-Type": "application/json",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
  }

  /** Liste les tools disponibles. */
  async listTools() {
    const result = await this._request("tools/list");
    return result?.tools ?? [];
  }

  /** Appelle un tool MCP. */
  async callTool(name, args = {}) {
    const result = await this._request("tools/call", { name, arguments: args });
    return result;
  }

  /** Liste les resources disponibles. */
  async listResources() {
    const result = await this._request("resources/list");
    return result?.resources ?? [];
  }

  /** Lit une resource MCP. */
  async readResource(uri) {
    const result = await this._request("resources/read", { uri });
    const contents = result?.contents ?? [];
    if (contents.length === 0) return null;
    const text = contents[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

// Exporter en global
window.McpClient = McpClient;

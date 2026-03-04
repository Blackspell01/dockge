/**
 * No-auth test entrypoint for Dockge.
 *
 * Starts a normal DockgeServer, then post-startup:
 * 1. Creates an admin user if none exists
 * 2. Sets disableAuth in the settings DB (triggers auto-login for all sockets)
 * 3. Creates an internal socket so the REST API can proxy to agents
 *
 * This keeps ALL no-auth logic out of production source files.
 */
import { log } from "../../backend/log";
import { io as ioConnect } from "socket.io-client";

log.info("test", "Starting Dockge in no-auth test mode (test entrypoint)");

// Monkey-patch AgentManager.connect to skip login (remote agent also has disableAuth)
import { AgentManager } from "../../backend/agent-manager";
const originalConnect = AgentManager.prototype.connect;
AgentManager.prototype.connect = function (url: string, username: string, password: string) {
    const obj = new URL(url);
    const endpoint = obj.host;

    this.socket.emit("agentStatus", { endpoint, status: "connecting" });

    if (!endpoint) {
        log.error("agent-manager", "Invalid endpoint: " + endpoint + " URL: " + url);
        return;
    }

    if ((this as any).agentSocketList[endpoint]) {
        log.debug("agent-manager", "Already connected to the socket server: " + endpoint);
        return;
    }

    log.info("agent-manager", "Connecting to the socket server: " + endpoint);

    const client = ioConnect(url, { extraHeaders: { endpoint } });

    client.on("connect", () => {
        log.info("agent-manager", "Connected (no-auth): " + endpoint);
        // disableAuth on the agent auto-logs us in, so just mark as logged in
        (this as any).agentLoggedInList[endpoint] = true;
        this.socket.emit("agentStatus", { endpoint, status: "online" });
    });

    client.on("connect_error", () => {
        log.error("agent-manager", "Error from the socket server: " + endpoint);
        this.socket.emit("agentStatus", { endpoint, status: "offline" });
    });

    client.on("disconnect", () => {
        log.info("agent-manager", "Disconnected from the socket server: " + endpoint);
        this.socket.emit("agentStatus", { endpoint, status: "offline" });
    });

    client.on("agent", (...args: unknown[]) => {
        this.socket.emit("agent", ...args);
    });

    client.on("info", (res: any) => {
        log.debug("agent-manager", res);
    });

    (this as any).agentSocketList[endpoint] = client;
};

// Now start the server
import { DockgeServer } from "../../backend/dockge-server";
import { R } from "redbean-node";
import { generatePasswordHash } from "../../backend/password-hash";
import { io as ioClient } from "socket.io-client";

const server = new DockgeServer();

const originalServe = server.serve.bind(server);
server.serve = async function () {
    await originalServe();

    // 1. Create admin user if none exists
    const userCount = (await R.knex("user").count("id as count").first()).count;
    if (userCount == 0) {
        log.info("test", "Creating default admin user");
        const user = R.dispense("user");
        user.username = "admin";
        user.password = generatePasswordHash("admin");
        await R.store(user);
        server.needSetup = false;
    }

    // 2. Set disableAuth so all sockets auto-login
    await R.exec(
        "INSERT OR REPLACE INTO setting (`key`, value, type) VALUES (?, ?, ?)",
        ["disableAuth", "true", "boolean"]
    );
    log.info("test", "disableAuth set in DB — all sockets will auto-login");

    // 3. Create internal socket for API agent proxying
    const protocol = server.isSSL() ? "https" : "http";
    const url = `${protocol}://localhost:${server.config.port}`;
    log.info("test", "Creating internal socket connection to " + url);
    const internalSocket = ioClient(url, { reconnection: true });
    internalSocket.on("connect", () => {
        log.info("test", "Internal socket connected for API agent proxying");
    });
    internalSocket.on("connect_error", (err: Error) => {
        log.warn("test", "Internal socket connection error: " + err.message);
    });
};

server.serve();

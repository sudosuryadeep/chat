/**
 * ================================================================
 *  VIDEO CHAT APP - server.js
 *  Express + Socket.IO + Cloudinary (media) + MongoDB (chat data)
 * ================================================================
 *  Features:
 *   - Multiple independent groups/rooms — har group ka apna unique
 *     code (aur chahe to password), "+" se naya group banao, code/
 *     invite-link se doosre group me join karo
 *   - Realtime chat (Socket.IO), scoped per-room
 *   - File / photo / video upload -> stored on Cloudinary
 *   - Reply-to-message (like WhatsApp/Telegram)
 *   - Messages permanently saved in MongoDB (roomId ke saath)
 *   - Online users list — per room
 *   - Delete / clear chat (also removes Cloudinary media) - room
 *     admin (jisne group banaya) ya global admin ke liye
 *   - Custom chat background per room (persisted to disk, broadcast)
 *   - Timestamps
 *   - Group voice/video calling (WebRTC mesh, 2-4 log, per-room)
 * ================================================================
 *
 *  NOTE on room passwords: ye ek casual "shared join code" jaisa hai
 *  (jaise WhatsApp group invite link), production-grade security
 *  nahi hai — plaintext compare hota hai. Agar real security chahiye
 *  (bcrypt hashing waghera) to bata dena, add kar denge.
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
const { Server } = require("socket.io");
const fs = require("fs");

const SETTINGS_FILE = path.join(__dirname, "settings.json");

// settings ab { [roomCode]: backgroundUrl } shape ka object hai —
// har group ki apni background choice alag se yaad rehti hai.
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (e) {
    return {};
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let roomBackgrounds = loadSettings(); // { roomCode: url|null }

// Ye username hamesha HAR group me admin rahega (super-admin), chahe
// usne wo group banaya ho ya nahi. Isके alawa, jisne group banaya wo
// khud-ba-khud USI group ka admin ban jaata hai.
const ADMIN_USERNAME = "admin";

// ---------------------------------------------------------------
// Basic setup
// ---------------------------------------------------------------
const app = express();
app.set("trust proxy", true); // Cloudflare/nginx ke peeche real visitor IP dikhane ke liye

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// Cloudinary config (.env se)
// ---------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------------------------------------------------------
// MongoDB connect (.env se)
// ---------------------------------------------------------------
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// ---------------------------------------------------------------
// Room (group) schema
// ---------------------------------------------------------------
const roomSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true }, // e.g. "K7QX2P"
  name: { type: String, required: true },
  password: { type: String, default: "" }, // "" = koi password nahi
  createdBy: { type: String, default: "" }, // is group ka admin
  createdAt: { type: Date, default: Date.now },
});
const Room = mongoose.model("Room", roomSchema);

// ---------------------------------------------------------------
// Message schema (ab roomId ke saath scoped)
// ---------------------------------------------------------------
const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  roomId: { type: String, required: true, index: true },
  username: { type: String, required: true },
  text: { type: String, default: "" },
  attachment: {
    url: String,
    publicId: String, // Cloudinary public_id (delete karne ke liye chahiye)
    name: String,
    size: Number,
    mimetype: String,
    type: { type: String, enum: ["image", "video", "file"] },
  },
  replyTo: {
    id: String,
    username: String,
    preview: String,
  },
  timestamp: { type: Date, default: Date.now },
});

const Message = mongoose.model("Message", messageSchema);

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.use(cors());
app.use(express.json());

// Visitor IP logging (Cloudflare/nginx proxy ke peeche real IP)
app.use((req, res, next) => {
  const visitorIp = req.headers["cf-connecting-ip"] || req.ip;
  console.log(`📍 Visitor: ${visitorIp} -> ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname))); // serves index.html from root

// ---------------------------------------------------------------
// Multer config - memory storage (buffer seedha Cloudinary ko jaata hai,
// disk pe kuch save nahi hota)
// ---------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

function attachmentTypeFor(mimetype) {
  if (!mimetype) return "file";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  return "file";
}

function resourceTypeFor(type) {
  if (type === "video") return "video";
  if (type === "image") return "image";
  return "raw"; // pdf, zip, docs, etc.
}

function uploadBufferToCloudinary(buffer, resourceType, originalName) {
  return new Promise((resolve, reject) => {
    const options = { resource_type: resourceType, folder: "video-chat-app" };

    // "raw" resources (PDF, ZIP, DOCX, etc.) ke case me Cloudinary
    // image/video jaisa alag se extension nahi jodta — extension
    // public_id ke andar hi dena padta hai, warna URL bina extension
    // ke ban jaata hai aur file download hone par corrupt/unusable lagti hai.
    if (resourceType === "raw" && originalName) {
      const ext = path.extname(originalName); // ".pdf"
      const base = path
        .basename(originalName, ext)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 60);
      const uniqueId = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      options.public_id = `${uniqueId}-${base}${ext}`;
    }

    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType })
    .catch((err) => console.error("Cloudinary delete error:", err.message));
}

async function clearRoomMessagesAndMedia(roomCode) {
  const all = await Message.find({ roomId: roomCode, "attachment.publicId": { $ne: null } }).lean();
  await Promise.all(
    all.map((m) => deleteFromCloudinary(m.attachment.publicId, resourceTypeFor(m.attachment.type)))
  );
  await Message.deleteMany({ roomId: roomCode });
}

// ---------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // confusing chars (0/O, 1/I) hataye

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

async function createUniqueRoomCode() {
  // Bahut kam chance hai clash ka (6 chars, 33 options = 33^6), lekin
  // fir bhi retry loop laga rahe hain taaki guarantee rahe.
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateRoomCode();
    const exists = await Room.exists({ code });
    if (!exists) return code;
  }
  throw new Error("Room code generate nahi ho paya, dobara try karein.");
}

async function isRoomAdmin(username, roomCode) {
  if (!username) return false;
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return true;
  const room = await Room.findOne({ code: roomCode }).lean();
  return !!(room && room.createdBy && room.createdBy.toLowerCase() === username.toLowerCase());
}

// ---------------------------------------------------------------
// REST Routes
// ---------------------------------------------------------------

// Naya group banao
app.post("/api/rooms", async (req, res) => {
  try {
    const name = (req.body.name || "").trim().slice(0, 40) || "Group Chat";
    const password = (req.body.password || "").trim().slice(0, 40);
    const createdBy = (req.body.username || "").trim().slice(0, 20);
    const code = await createUniqueRoomCode();
    await Room.create({ code, name, password, createdBy });
    res.json({ code, name, hasPassword: !!password });
  } catch (err) {
    console.error("Room create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Group ka basic info check karo (join screen ke liye — password khud
// nahi bhejte, sirf ye batate hain ki chahiye ya nahi)
app.get("/api/rooms/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").toUpperCase().trim();
    const room = await Room.findOne({ code }).lean();
    if (!room) return res.status(404).json({ error: "Group nahi mila. Code check karein." });
    res.json({ code: room.code, name: room.name, hasPassword: !!room.password });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all chat messages of a room (initial load / fallback)
app.get("/api/messages", async (req, res) => {
  try {
    const roomCode = (req.query.room || "").toUpperCase().trim();
    if (!roomCode) return res.status(400).json({ error: "room code chahiye" });
    const messages = await Message.find({ roomId: roomCode }).sort({ timestamp: 1 }).lean();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload any file (photo / video / document) -> Cloudinary -> attachment metadata
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "File nahi mili." });
  }
  try {
const type = attachmentTypeFor(req.file.mimetype);
const resourceType = resourceTypeFor(type);
const result = await uploadBufferToCloudinary(req.file.buffer, resourceType, req.file.originalname);

    // Cloudinary ka "download" URL banate hain (fl_attachment flag)
// taaki browser hamesha force-download kare, sirf navigate/preview na kare.
const downloadUrl = result.secure_url.includes("/upload/")
  ? result.secure_url.replace("/upload/", "/upload/fl_attachment/")
  : result.secure_url;

const attachment = {
  url: result.secure_url,       // inline preview ke liye (img/video src)
  downloadUrl,                  // download button/link ke liye
  publicId: result.public_id,
  name: req.file.originalname,
  size: req.file.size,
  mimetype: req.file.mimetype,
  type,
};
res.json({ attachment });
  } catch (err) {
    console.error("Cloudinary upload error:", err.message);
    res.status(500).json({ error: "Upload fail ho gaya: " + err.message });
  }
});

// Poore group ka chat clear karo (DB + Cloudinary media) — sirf us
// group ke admin ya global admin. ?room=CODE&username=admin
app.delete("/api/messages", async (req, res) => {
  try {
    const roomCode = (req.query.room || "").toUpperCase().trim();
    const requester = (req.query.username || "").trim();
    if (!roomCode) return res.status(400).json({ error: "room code chahiye" });

    const allowed = await isRoomAdmin(requester, roomCode);
    if (!allowed) {
      return res.status(403).json({ error: "Sirf group admin hi chat clear kar sakta hai." });
    }
    await clearRoomMessagesAndMedia(roomCode);
    io.to(roomCode).emit("chatCleared");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete single message by id
app.delete("/api/messages/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const msg = await Message.findOne({ id });
    if (!msg) return res.json({ success: true });
    if (msg.attachment?.publicId) {
      await deleteFromCloudinary(msg.attachment.publicId, resourceTypeFor(msg.attachment.type));
    }
    await Message.deleteOne({ id });
    io.to(msg.roomId).emit("messageDeleted", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Socket.IO - realtime chat + online users + group call signaling
// Sab kuch ab per-room (Socket.IO rooms use karte hain via
// socket.join(roomCode)) — ek group ki koi bhi cheez doosre group me
// kabhi nahi dikhti.
// ---------------------------------------------------------------
const roomOnlineUsers = new Map(); // roomCode -> Map(socketId -> username)
const roomCallParticipants = new Map(); // roomCode -> Map(socketId -> username)

function broadcastOnlineUsers(roomCode) {
  const map = roomOnlineUsers.get(roomCode);
  io.to(roomCode).emit("onlineUsers", map ? Array.from(map.values()) : []);
}

function broadcastCallParticipants(roomCode) {
  const map = roomCallParticipants.get(roomCode);
  io.to(roomCode).emit("callParticipants", map ? Array.from(map.values()) : []);
}

io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  socket.data.roomCode = null;
  socket.data.username = null;

  // Ek socket ko uske current group se nikaal ke sab jagah se saaf
  // karta hai — naya group join karne se pehle, ya disconnect pe.
  function leaveCurrentRoom() {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    socket.leave(roomCode);

    const onlineMap = roomOnlineUsers.get(roomCode);
    if (onlineMap) {
      onlineMap.delete(socket.id);
      broadcastOnlineUsers(roomCode);
    }

    // Agar disconnect hone wala banda hi video ka controller tha, to control
// kisi aur online member ko de do (agar koi bacha hai), warna PiP band kar do
const pipState = roomPipState.get(roomCode);
if (pipState && pipState.controller === socket.data.username) {
  const remaining = onlineMap ? Array.from(onlineMap.values()) : [];
  if (remaining.length > 0) {
    pipState.controller = remaining[0];
    io.to(roomCode).emit("pip:controllerChanged", { controller: pipState.controller });
  } else {
    roomPipState.delete(roomCode);
    io.to(roomCode).emit("pip:close");
  }
}
    const callMap = roomCallParticipants.get(roomCode);
    if (callMap && callMap.has(socket.id)) {
      callMap.delete(socket.id);
      socket.to(roomCode).emit("call:userLeft", socket.id);
      broadcastCallParticipants(roomCode);
    }

    if (socket.data.username) {
      socket.to(roomCode).emit("systemMessage", `${socket.data.username} chat se chala gaya 🚪`);
    }

    socket.data.roomCode = null;
  }

  // payload: { username, roomCode, password }
  socket.on("join", async (payload) => {
    const username = (payload?.username || "").trim().slice(0, 20);
    const roomCode = (payload?.roomCode || "").toUpperCase().trim();
    const password = payload?.password || "";

    if (!username || !roomCode) {
      socket.emit("joinError", "Naam aur group code dono chahiye.");
      return;
    }

    let room;
    try {
      room = await Room.findOne({ code: roomCode }).lean();
    } catch (err) {
      socket.emit("joinError", "Server se connect nahi ho paaya, dobara try karein.");
      return;
    }
    if (!room) {
      socket.emit("joinError", "Ye group nahi mila. Code check karein.");
      return;
    }
    if (room.password && room.password !== password) {
      socket.emit("joinError", "Password galat hai.");
      return;
    }

    // Agar pehle se kisi group me tha (group switch kar raha hai), pehle
    // wahan se cleanly nikal jao.
    leaveCurrentRoom();

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.username = username;

    if (!roomOnlineUsers.has(roomCode)) roomOnlineUsers.set(roomCode, new Map());
    roomOnlineUsers.get(roomCode).set(socket.id, username);
    broadcastOnlineUsers(roomCode);

    let history = [];
    try {
      history = await Message.find({ roomId: roomCode }).sort({ timestamp: 1 }).lean();
    } catch (err) {
      console.error("MongoDB read error:", err.message);
    }
    socket.emit("chatHistory", history);

    const admin = await isRoomAdmin(username, roomCode);
    socket.emit("roomJoined", { code: room.code, name: room.name, isAdmin: admin });

    // Is group ki current background bhej do
    socket.emit("backgroundChanged", roomBackgrounds[roomCode] || null);

    // Agar is group me PiP video already float ho raha hai, naye aane wale ko bhi bhejo
const pipState = roomPipState.get(roomCode);
if (pipState) {
  socket.emit("pip:open", {
    videoUrl: pipState.videoUrl,
    startAt: pipState.startAt,
    openedBy: pipState.controller,
    controller: pipState.controller,
  });
}

    // Agar is group me call already chal rahi hai, naye aane wale ko batao
    const callMap = roomCallParticipants.get(roomCode);
    if (callMap && callMap.size > 0) {
      socket.emit("callParticipants", Array.from(callMap.values()));
    }

    socket.to(roomCode).emit("systemMessage", `${username} chat me aa gaya/gayi hai 👋`);
  });

  // User ne "Switch Group" dabaya — current group chhodo, socket connected
  // rahega, client dobara "join" bhejega jab naya group choose karega.
  socket.on("leaveRoom", () => {
    leaveCurrentRoom();
  });

  // New chat message (text and/or attachment, optionally a reply)
  socket.on("chatMessage", async (payload) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return; // kisi group me nahi hai, ignore

    const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timestamp = new Date();

    const messageDoc = {
      id,
      roomId: roomCode,
      username: payload.username || socket.data.username || "Anonymous",
      text: payload.text || "",
      attachment: payload.attachment || null,
      replyTo: payload.replyTo
        ? {
            id: payload.replyTo.id,
            username: payload.replyTo.username,
            preview: payload.replyTo.preview || "",
          }
        : null,
      timestamp,
    };

    try {
      await Message.create(messageDoc);
    } catch (err) {
      console.error("MongoDB save error:", err.message);
    }

    // clientTempId sirf realtime round-trip ke liye hai (taaki sender apna
    // hi bheja hua attachment local blob se turant dekh sake) - DB me save
    // nahi hota, isliye broadcast karte waqt alag se jodte hain.
    io.to(roomCode).emit("chatMessage", { ...messageDoc, clientTempId: payload.clientTempId || null });
  });

  // payload: { id, username }
  socket.on("deleteMessage", async (payload) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const id = typeof payload === "string" ? payload : payload?.id;
    const requester = typeof payload === "object" ? payload?.username : socket.data.username;
    if (!id) return;

    try {
      const msg = await Message.findOne({ id, roomId: roomCode });
      if (!msg) return; // pehle se delete ho chuka / exist nahi karta / doosre room ka hai

      const isOwner = requester && msg.username === requester;
      const isAdminUser = await isRoomAdmin(requester, roomCode);

      if (!isOwner && !isAdminUser) {
        socket.emit("systemMessage", "Aap sirf apna message delete kar sakte hain.");
        return;
      }

      if (msg.attachment?.publicId) {
        await deleteFromCloudinary(msg.attachment.publicId, resourceTypeFor(msg.attachment.type));
      }
      await Message.deleteOne({ id });
    } catch (err) {
      console.error("MongoDB delete error:", err.message);
      return;
    }
    io.to(roomCode).emit("messageDeleted", id);
  });

  // Sirf is group ka admin (creator) ya global admin poora chat clear kar sakta hai
  socket.on("clearChat", async () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;

    const allowed = await isRoomAdmin(socket.data.username, roomCode);
    if (!allowed) {
      socket.emit("systemMessage", "Sirf group admin hi chat clear kar sakta hai.");
      return;
    }
    try {
      await clearRoomMessagesAndMedia(roomCode);
    } catch (err) {
      console.error("MongoDB clear error:", err.message);
    }
    io.to(roomCode).emit("chatCleared");
  });


  // ---- Member ko group se remove karna (sirf admin) ----
socket.on("kickMember", async ({ targetUsername }) => {
  const roomCode = socket.data.roomCode;
  const requester = socket.data.username;
  if (!roomCode || !targetUsername) return;

  const allowed = await isRoomAdmin(requester, roomCode);
  if (!allowed) {
    socket.emit("systemMessage", "Sirf group admin hi kisi ko remove kar sakta hai.");
    return;
  }
  if (targetUsername === requester) {
    socket.emit("systemMessage", "Aap khud ko remove nahi kar sakte.");
    return;
  }

  const onlineMap = roomOnlineUsers.get(roomCode);
  if (!onlineMap) return;

  const targets = [];
  onlineMap.forEach((uname, sockId) => {
    if (uname === targetUsername) targets.push(sockId);
  });

  targets.forEach((sockId) => {
    const targetSocket = io.sockets.sockets.get(sockId);
    if (targetSocket) {
      targetSocket.emit("kicked", { by: requester });
      targetSocket.leave(roomCode);
      onlineMap.delete(sockId);

      const callMap = roomCallParticipants.get(roomCode);
      if (callMap && callMap.has(sockId)) {
        callMap.delete(sockId);
        socket.to(roomCode).emit("call:userLeft", sockId);
        broadcastCallParticipants(roomCode);
      }
      targetSocket.data.roomCode = null;
    }
  });

  broadcastOnlineUsers(roomCode);
  io.to(roomCode).emit("systemMessage", `${targetUsername} ko group se hata diya gaya`);
});

// ---- Group ka naam badalna (sirf admin) ----
socket.on("renameGroup", async ({ newName }) => {
  const roomCode = socket.data.roomCode;
  const requester = socket.data.username;
  const name = (newName || "").trim().slice(0, 40);
  if (!roomCode || !name) return;

  const allowed = await isRoomAdmin(requester, roomCode);
  if (!allowed) {
    socket.emit("systemMessage", "Sirf group admin hi naam badal sakta hai.");
    return;
  }

  try {
    await Room.updateOne({ code: roomCode }, { name });
  } catch (err) {
    console.error("Rename error:", err.message);
    return;
  }
  io.to(roomCode).emit("roomUpdated", { code: roomCode, name });
  io.to(roomCode).emit("systemMessage", `Group ka naam badal kar "${name}" kar diya gaya`);
});

// ---- Group ki ID/code badalna (sirf admin) ----
socket.on("changeGroupCode", async ({ newCode }) => {
  const oldCode = socket.data.roomCode;
  const requester = socket.data.username;
  const code = (newCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);

  if (!oldCode || !code || code.length < 4) {
    socket.emit("systemMessage", "Sahi group ID daalein (kam se kam 4 characters).");
    return;
  }

  const allowed = await isRoomAdmin(requester, oldCode);
  if (!allowed) {
    socket.emit("systemMessage", "Sirf group admin hi group ID badal sakta hai.");
    return;
  }
  if (code === oldCode) return;

  const exists = await Room.exists({ code });
  if (exists) {
    socket.emit("systemMessage", "Ye group ID pehle se use ho rahi hai. Doosri try karein.");
    return;
  }

  try {
    await Room.updateOne({ code: oldCode }, { code });
    await Message.updateMany({ roomId: oldCode }, { roomId: code });
  } catch (err) {
    console.error("Code change error:", err.message);
    socket.emit("systemMessage", "Group ID badalne me error aayi.");
    return;
  }

  if (roomBackgrounds[oldCode] !== undefined) {
    roomBackgrounds[code] = roomBackgrounds[oldCode];
    delete roomBackgrounds[oldCode];
    saveSettings(roomBackgrounds);
  }

  const onlineMap = roomOnlineUsers.get(oldCode);
  if (onlineMap) {
    roomOnlineUsers.set(code, onlineMap);
    roomOnlineUsers.delete(oldCode);
  }
  const callMap = roomCallParticipants.get(oldCode);
  if (callMap) {
    roomCallParticipants.set(code, callMap);
    roomCallParticipants.delete(oldCode);
  }

  const roomSockets = await io.in(oldCode).fetchSockets();
  roomSockets.forEach((s) => {
    s.join(code);
    s.leave(oldCode);
    s.data.roomCode = code;
  });

  io.to(code).emit("roomCodeChanged", { oldCode, newCode: code });
});

  // Chat background badalna (is group ke sabke liye persist + broadcast)
  socket.on("setBackground", (url) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    roomBackgrounds[roomCode] = url || null;
    saveSettings(roomBackgrounds); // disk par persist (server restart ke baad bhi yaad rahega)
    io.to(roomCode).emit("backgroundChanged", roomBackgrounds[roomCode]);
  });

// Per-room PiP state: kaunsa video khula hai, kiske paas control hai
const roomPipState = new Map(); // roomCode -> { videoUrl, startAt, controller }

function pipControllerGuard(socket) {
  const roomCode = socket.data.roomCode;
  const state = roomPipState.get(roomCode);
  if (!roomCode || !state) return null;
  if (state.controller !== socket.data.username) return null;
  return { roomCode, state };
}

socket.on("pip:open", ({ videoUrl, startAt }) => {
  const roomCode = socket.data.roomCode;
  const username = socket.data.username;
  if (!roomCode || !videoUrl) return;

  roomPipState.set(roomCode, { videoUrl, startAt: startAt || 0, controller: username });

  socket.to(roomCode).emit("pip:open", {
    videoUrl,
    startAt: startAt || 0,
    openedBy: username,
    controller: username,
  });
});

socket.on("pip:close", () => {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  roomPipState.delete(roomCode);
  socket.to(roomCode).emit("pip:close");
});

// Sirf current controller ke play/pause/seek sabko sync hote hain
socket.on("pip:play", ({ time }) => {
  const ctx = pipControllerGuard(socket);
  if (!ctx) return;
  socket.to(ctx.roomCode).emit("pip:play", { time });
});

socket.on("pip:pause", ({ time }) => {
  const ctx = pipControllerGuard(socket);
  if (!ctx) return;
  socket.to(ctx.roomCode).emit("pip:pause", { time });
});

socket.on("pip:seek", ({ time }) => {
  const ctx = pipControllerGuard(socket);
  if (!ctx) return;
  socket.to(ctx.roomCode).emit("pip:seek", { time });
});

// Koi bhi control maang sakta hai — request current controller ko jaati hai
socket.on("pip:requestControl", () => {
  const roomCode = socket.data.roomCode;
  const state = roomPipState.get(roomCode);
  if (!roomCode || !state) return;

  const onlineMap = roomOnlineUsers.get(roomCode);
  if (!onlineMap) return;

  let targetSocketId = null;
  onlineMap.forEach((uname, sockId) => {
    if (uname === state.controller) targetSocketId = sockId;
  });

  if (targetSocketId) {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) targetSocket.emit("pip:controlRequested", { from: socket.data.username });
  }
});

// Control dena — sirf current controller ya group admin de sakta hai,
// bina request ke bhi (proactively) diya ja sakta hai
socket.on("pip:grantControl", async ({ to }) => {
  const roomCode = socket.data.roomCode;
  const state = roomPipState.get(roomCode);
  if (!roomCode || !state || !to) return;

  const requester = socket.data.username;
  const admin = await isRoomAdmin(requester, roomCode);
  if (state.controller !== requester && !admin) return;

  const onlineMap = roomOnlineUsers.get(roomCode);
  const isOnline = onlineMap && Array.from(onlineMap.values()).includes(to);
  if (!isOnline) return;

  state.controller = to;
  io.to(roomCode).emit("pip:controllerChanged", { controller: to });
});

  socket.on("typing", (username) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("userTyping", username);
  });
  socket.on("stopTyping", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    socket.to(roomCode).emit("userStopTyping");
  });

  // ---------------------------------------------------------------
  // Group voice/video call signaling (WebRTC mesh) — per room.
  // Server sirf messages relay karta hai (offer/answer/ICE candidates) -
  // actual audio/video stream kabhi server se hokar nahi jaata, seedha
  // browser-se-browser jaata hai. 2-4 logon ke liye ye kaafi hai.
  // ---------------------------------------------------------------
  socket.on("call:join", () => {
    const roomCode = socket.data.roomCode;
    const username = socket.data.username;
    if (!roomCode || !username) return;

    if (!roomCallParticipants.has(roomCode)) roomCallParticipants.set(roomCode, new Map());
    const callMap = roomCallParticipants.get(roomCode);

    // Naye joiner ko batao ki call me pehle se kaun kaun hai, taaki
    // woh un sabko offer bhej sake.
    const existing = Array.from(callMap.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ socketId: id, username: name }));
    socket.emit("call:existingParticipants", existing);

    callMap.set(socket.id, username);
    socket.to(roomCode).emit("call:userJoined", { socketId: socket.id, username });
    broadcastCallParticipants(roomCode);
  });

  // payload: { to: socketId, data: { sdp } | { candidate } }
  // Point-to-point relay — sirf jisko bheja gaya hai wahi receive karta hai,
  // aur sirf tabhi jab dono same room me hon.
  socket.on("call:signal", ({ to, data }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !to || !data) return;

    const targetSocket = io.sockets.sockets.get(to);
    if (!targetSocket || targetSocket.data.roomCode !== roomCode) return;

    targetSocket.emit("call:signal", { from: socket.id, username: socket.data.username, data });
  });

  socket.on("call:leave", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const callMap = roomCallParticipants.get(roomCode);
    if (callMap && callMap.has(socket.id)) {
      callMap.delete(socket.id);
      socket.to(roomCode).emit("call:userLeft", socket.id);
      broadcastCallParticipants(roomCode);
    }
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom();
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});


// ---------------------------------------------------------------
// TURN server credentials (Metered.ca) - client ko securely deta hai
// ---------------------------------------------------------------
const METERED_APP_DOMAIN = "aerivue.metered.live"; // <-- apna domain yahan daalo
const METERED_API_KEY = "mjP8vHtOP0ORrpEiAm5Y0yqKMUYgUTDDXE24y0bmdDLxl72k";   // <-- apni API key yahan daalo

app.get("/api/turn-credentials", async (req, res) => {
  try {
    const response = await fetch(
      `https://${METERED_APP_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("TURN credentials fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Error handler (e.g. multer size-limit errors)
// ---------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

// ---------------------------------------------------------------
// Start server
// ---------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Server chal raha hai: http://localhost:${PORT}`);
});
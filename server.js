/**
 * ================================================================
 *  VIDEO CHAT APP - server.js
 *  Express + Socket.IO + Cloudinary (media) + MongoDB (chat data)
 * ================================================================
 *  Features:
 *   - Realtime chat (Socket.IO)
 *   - File / photo / video upload -> stored on Cloudinary
 *   - Reply-to-message (like WhatsApp/Telegram)
 *   - Messages permanently saved in MongoDB
 *   - Online users list
 *   - Delete / clear chat (also removes Cloudinary media) - admin only
 *   - Custom chat background (persisted to disk, broadcast to everyone)
 *   - Timestamps
 * ================================================================
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

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (e) {
    return { background: null };
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

// Username jo chat clear karne ki permission rakhta hai (case-insensitive match)
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
// Message schema
// ---------------------------------------------------------------
const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
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

function uploadBufferToCloudinary(buffer, resourceType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder: "video-chat-app" },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

function deleteFromCloudinary(publicId, resourceType) {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader
    .destroy(publicId, { resource_type: resourceType })
    .catch((err) => console.error("Cloudinary delete error:", err.message));
}

async function clearAllMessagesAndMedia() {
  const all = await Message.find({ "attachment.publicId": { $ne: null } }).lean();
  await Promise.all(
    all.map((m) => deleteFromCloudinary(m.attachment.publicId, resourceTypeFor(m.attachment.type)))
  );
  await Message.deleteMany({});
}

// ---------------------------------------------------------------
// REST Routes
// ---------------------------------------------------------------

// Get all chat messages (initial load / fallback)
app.get("/api/messages", async (req, res) => {
  try {
    const messages = await Message.find().sort({ timestamp: 1 }).lean();
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
    const result = await uploadBufferToCloudinary(req.file.buffer, resourceType);

    const attachment = {
      url: result.secure_url,
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

// Clear entire chat (DB + Cloudinary media) — requires ?username=admin
// NOTE: REST route ke paas socket jaisa "logged in user" context nahi hota,
// isliye admin username query param se pass karwaya jaa raha hai.
app.delete("/api/messages", async (req, res) => {
  const requester = (req.query.username || "").toLowerCase();
  if (requester !== ADMIN_USERNAME.toLowerCase()) {
    return res.status(403).json({ error: "Sirf admin hi chat clear kar sakta hai." });
  }
  try {
    await clearAllMessagesAndMedia();
    io.emit("chatCleared");
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
    if (msg?.attachment?.publicId) {
      await deleteFromCloudinary(msg.attachment.publicId, resourceTypeFor(msg.attachment.type));
    }
    await Message.deleteOne({ id });
    io.emit("messageDeleted", id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Socket.IO - realtime chat + online users
// ---------------------------------------------------------------
const onlineUsers = new Map(); // socket.id -> username

function broadcastOnlineUsers() {
  io.emit("onlineUsers", Array.from(onlineUsers.values()));
}

io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  let currentUsername = null;

  socket.on("join", async (username) => {
    currentUsername = username;
    onlineUsers.set(socket.id, username);
    broadcastOnlineUsers();

    try {
      const history = await Message.find().sort({ timestamp: 1 }).lean();
      socket.emit("chatHistory", history);
    } catch (err) {
      console.error("MongoDB read error:", err.message);
      socket.emit("chatHistory", []);
    }

    // Naye user ko current background bhi bhej do
    socket.emit("backgroundChanged", settings.background);

    socket.broadcast.emit("systemMessage", `${username} chat me aa gaya/gayi hai 👋`);
  });

  // New chat message (text and/or attachment, optionally a reply)
  socket.on("chatMessage", async (payload) => {
    // payload: { username, text, attachment, clientTempId, replyTo }
    const id = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const timestamp = new Date();

    const messageDoc = {
      id,
      username: payload.username || "Anonymous",
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
    io.emit("chatMessage", { ...messageDoc, clientTempId: payload.clientTempId || null });
  });

  // payload: { id, username } — username batata hai kisne delete karne ki
  // koshish ki, taaki hum verify kar sakein ki woh sirf apna hi message
  // delete kar raha hai (ya woh admin hai).
  socket.on("deleteMessage", async (payload) => {
    const id = typeof payload === "string" ? payload : payload?.id;
    const requester = typeof payload === "object" ? payload?.username : null;
    if (!id) return;

    try {
      const msg = await Message.findOne({ id });
      if (!msg) return; // pehle se delete ho chuka / exist nahi karta

      const isOwner = requester && msg.username === requester;
      const isAdminUser = requester && requester.toLowerCase() === ADMIN_USERNAME.toLowerCase();

      if (!isOwner && !isAdminUser) {
        socket.emit("systemMessage", "Aap sirf apna message delete kar sakte hain.");
        return; // koi bhi doosre ka message delete nahi kar sakta
      }

      if (msg.attachment?.publicId) {
        await deleteFromCloudinary(msg.attachment.publicId, resourceTypeFor(msg.attachment.type));
      }
      await Message.deleteOne({ id });
    } catch (err) {
      console.error("MongoDB delete error:", err.message);
      return;
    }
    io.emit("messageDeleted", id);
  });

  // Sirf admin hi poora chat clear kar sakta hai
  socket.on("clearChat", async () => {
    if (!currentUsername || currentUsername.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
      socket.emit("systemMessage", "Sirf admin hi chat clear kar sakta hai.");
      return; // silently ignore — koi bhi non-admin isko trigger nahi kar sakta
    }
    try {
      await clearAllMessagesAndMedia();
    } catch (err) {
      console.error("MongoDB clear error:", err.message);
    }
    io.emit("chatCleared");
  });

  // Chat background badalna (sabke liye persist + broadcast)
  socket.on("setBackground", (url) => {
    settings.background = url || null;
    saveSettings(settings); // disk par persist (server restart ke baad bhi yaad rahega)
    io.emit("backgroundChanged", settings.background); // sabko turant broadcast
  });

  socket.on("typing", (username) => {
    socket.broadcast.emit("userTyping", username);
  });
  socket.on("stopTyping", () => {
    socket.broadcast.emit("userStopTyping");
  });

  socket.on("disconnect", () => {
    const username = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
    if (username) {
      io.emit("systemMessage", `${username} chat se chala gaya 🚪`);
    }
    console.log(`❌ Disconnected: ${socket.id}`);
  });
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
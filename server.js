const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ✅ Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// ✅ MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

// ✅ Gemini API
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

// =======================
// 📦 MODELS
// =======================

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String
}));

const Chat = mongoose.model('Chat', new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userMessage: String,
  botResponse: String,
  timestamp: { type: Date, default: Date.now }
}));

// =======================
// 🔐 AUTH ROUTES
// =======================

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ message: 'All fields required' });

  try {
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser)
      return res.status(400).json({ message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);

    await User.create({ username, email, password: hashedPassword });

    res.json({ message: 'Registered successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error registering user' });
  }
});

app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;

  try {
    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }]
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    req.session.user = {
      id: user._id,
      email: user.email,
      username: user.username
    };

    res.json({ message: 'Login successful' });
  } catch {
    res.status(500).json({ message: 'Login failed' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/check-auth', (req, res) => {
  res.json({ loggedIn: !!req.session.user });
});

// =======================
// 💬 CHAT WITH MEMORY
// =======================

app.post('/chat', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const { message } = req.body;
  if (!message) return res.status(400).json({ message: 'Message required' });

  const trimmedMessage = message.slice(0, 500);

  // 🔥 Fetch last 10 messages (memory)
  const history = await Chat.find({ userId: user.id })
    .sort({ timestamp: 1 })
    .limit(10);

  // 🔥 Convert to Gemini format
  const messages = [];

  history.forEach(chat => {
    messages.push({
      role: "user",
      parts: [{ text: chat.userMessage }]
    });

    messages.push({
      role: "model",
      parts: [{ text: chat.botResponse }]
    });
  });

  // Add current message
  messages.push({
    role: "user",
    parts: [{ text: trimmedMessage }]
  });

  // 🔁 Gemini call with retry
  async function callGemini(msgs, retries = 2) {
    try {
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
        { contents: msgs },
        { timeout: 8000 }
      );

      return response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    } catch (err) {
      if (err.response?.status === 503 && retries > 0) {
        console.log("⏳ Retry...");
        await new Promise(res => setTimeout(res, 2000));
        return callGemini(msgs, retries - 1);
      }
      throw err;
    }
  }

  let botReply;

  try {
    botReply = await callGemini(messages); // ✅ FIXED (passing messages)
  } catch(err) {
    console.error("❌ REAL ERROR:", err.response?.data || err.message);
    botReply = "🤖 Server busy. Try again.";
  }

  res.json({ reply: botReply });

  // Save in background
  Chat.create({
    userId: user.id,
    userMessage: trimmedMessage,
    botResponse: botReply
  });
});

// =======================
// 📜 HISTORY
// =======================

app.get('/history', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  const chats = await Chat.find({ userId: user.id })
    .sort({ timestamp: -1 })
    .limit(20);

  res.json(chats);
});

app.delete('/delete-history', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: 'Unauthorized' });

  await Chat.deleteMany({ userId: user.id });
  res.json({ message: 'Deleted' });
});

// =======================
// 🚀 START SERVER
// =======================

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
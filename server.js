const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// =======================
// 🔐 ENV CHECK (IMPORTANT)
// =======================
if (!process.env.MONGO_URI || !process.env.GEMINI_API_KEY) {
  console.error("❌ Missing environment variables");
  process.exit(1);
}

// =======================
// ✅ MIDDLEWARE
// =======================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "fallback_secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,   // set true if HTTPS
    httpOnly: true
  }
}));

// =======================
// 🗄️ MONGODB CONNECTION
// =======================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => {
  console.error("❌ MongoDB Error:", err);
  process.exit(1);
});

// =======================
// 🤖 GEMINI API
// =======================
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

  try {
    // Fetch last 10 chats
    const history = await Chat.find({ userId: user.id })
      .sort({ timestamp: 1 })
      .limit(10);

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

    messages.push({
      role: "user",
      parts: [{ text: trimmedMessage }]
    });

    // Gemini API call
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      { contents: messages },
      { timeout: 8000 }
    );

    const botReply =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "🤖 No response";

    res.json({ reply: botReply });

    // Save chat
    await Chat.create({
      userId: user.id,
      userMessage: trimmedMessage,
      botResponse: botReply
    });

  } catch (err) {
    console.error("❌ Gemini Error:", err.response?.data || err.message);
    res.json({ reply: "🤖 Server busy. Try again." });
  }
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
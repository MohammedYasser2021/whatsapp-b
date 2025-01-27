const express = require('express');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

const app = express();

// Setup multer for file storage with better error handling
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        try {
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        } catch (error) {
            cb(new Error('Could not create upload directory'));
        }
    },
    filename: function (req, file, cb) {
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const safeName = `${timestamp}${ext}`.replace(/[^a-zA-Z0-9.-]/g, '');
        cb(null, safeName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 16 * 1024 * 1024, // 16MB max file size
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'image/jpeg',
            'image/png',
            'image/gif',
            'video/mp4',
            'video/mpeg',
            'video/quicktime',
            'video/webm',
            'audio/mpeg',
            'audio/wav',
            'audio/ogg',
            'audio/webm',
            'audio/mp4',
            'audio/aac',
            'audio/x-m4a',
            'application/ogg'
        ];

        if (allowedMimes.includes(file.mimetype) || file.mimetype.startsWith('audio/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error(`نوع الملف غير مدعوم: ${file.mimetype}`));
        }
    }
});

app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
    optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use('/uploads', express.static('uploads'));

let client;
let connectionStatus = 'disconnected';
let qrCodeData = null;

async function destroyClient() {
    connectionStatus = 'disconnecting';
    if (client) {
        try {
            await client.destroy();
            client = null;
        } catch (error) {
            console.error('Error destroying client:', error);
        }
    }
    connectionStatus = 'disconnected';
    qrCodeData = null;
}

async function clearAuthData() {
    try {
        // Clear .wwebjs_auth directory
        const authDir = path.join(process.cwd(), '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('Cleared .wwebjs_auth directory');
        }

        // Clear .wwebjs_cache directory
        const cacheDir = path.join(process.cwd(), '.wwebjs_cache');
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            console.log('Cleared .wwebjs_cache directory');
        }

        // Clear any session files in the root directory
        const sessionFiles = ['.wwebjs_auth', '.wwebjs_cache'];
        for (const file of sessionFiles) {
            const filePath = path.join(process.cwd(), file);
            if (fs.existsSync(filePath)) {
                fs.rmSync(filePath, { recursive: true, force: true });
                console.log(`Cleared ${file}`);
            }
        }
    } catch (error) {
        console.error('Error clearing auth data:', error);
        throw error; // Propagate the error to handle it in the calling function
    }
}

function initializeWhatsApp() {
    connectionStatus = 'initializing';
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        connectionStatus = 'waiting-for-qr';
        qrCodeData = qr;
        qrcode.generate(qr, { small: true });
        console.log('QR Code generated! Scan with WhatsApp');
    });

    client.on('ready', () => {
        connectionStatus = 'connected';
        qrCodeData = null;
        console.log('WhatsApp client is ready!');
    });

    client.on('authenticated', () => {
        connectionStatus = 'authenticating';
        console.log('WhatsApp authenticated successfully!');
    });

    client.on('auth_failure', async (msg) => {
        console.error('Authentication failed:', msg);
        connectionStatus = 'disconnected';
        await clearAuthData();
        initializeWhatsApp();
    });

    client.on('disconnected', async () => {
        console.log('WhatsApp disconnected!');
        await destroyClient();
        await clearAuthData();
        initializeWhatsApp();
    });

    try {
        client.initialize().catch(async error => {
            console.error('Error during initialization:', error);
            connectionStatus = 'disconnected';
            await clearAuthData();
            initializeWhatsApp();
        });
    } catch (error) {
        console.error('Error initializing client:', error);
        connectionStatus = 'disconnected';
    }
}

// Initialize WhatsApp client
initializeWhatsApp();

app.get('/status', (req, res) => {
    res.json({ 
        status: connectionStatus,
        qrCode: qrCodeData
    });
});

app.post('/disconnect', async (req, res) => {
    try {
        await destroyClient();
        await clearAuthData();
        initializeWhatsApp();
        res.json({ success: true, message: 'Disconnected successfully' });
    } catch (error) {
        console.error('Error during disconnect:', error);
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

// Improved send-bulk-messages endpoint
app.post('/send-bulk-messages', async (req, res) => {
    if (!client || connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'WhatsApp client not connected' });
    }

    const { numbers, message, mediaPaths } = req.body;
    console.log('Received request:', { numbers, message, mediaPaths });

    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
        return res.status(400).json({ error: 'يجب توفير قائمة صالحة من الأرقام' });
    }

    if (!message && (!mediaPaths || mediaPaths.length === 0)) {
        return res.status(400).json({ error: 'يجب توفير رسالة أو ملف وسائط' });
    }

    const results = { success: [], failed: [] };
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const number of numbers) {
        try {
            let formattedNumber = number.toString().replace(/\D/g, '');
            if (!formattedNumber.startsWith('20')) {
                formattedNumber = '20' + formattedNumber;
            }
            const chatId = `${formattedNumber}@c.us`;

            // Check if number is registered on WhatsApp
            const isRegistered = await client.isRegisteredUser(chatId);
            if (!isRegistered) {
                throw new Error('رقم غير مسجل في واتساب');
            }

            // Send text message first if provided
            if (message) {
                await client.sendMessage(chatId, message);
                await delay(1000); // Wait 1 second between messages
            }

            // Send media files if provided
            if (mediaPaths && mediaPaths.length > 0) {
                for (const mediaPath of mediaPaths) {
                    try {
                        const fullPath = path.join(process.cwd(), mediaPath);
                        
                        if (!fs.existsSync(fullPath)) {
                            throw new Error('ملف الوسائط غير موجود');
                        }

                        const mimeType = mime.lookup(fullPath);
                        if (!mimeType) {
                            throw new Error('نوع الملف غير مدعوم');
                        }

                        const media = new MessageMedia(
                            mimeType,
                            fs.readFileSync(fullPath, { encoding: 'base64' }),
                            path.basename(fullPath)
                        );

                        await client.sendMessage(chatId, media, {
                            sendMediaAsDocument: mimeType.startsWith('video/'),
                        });

                        await delay(1000); // Wait 1 second between media files
                    } catch (mediaError) {
                        console.error('Media error:', mediaError);
                        throw new Error(`فشل في إرسال الوسائط: ${mediaError.message}`);
                    }
                }
            }

            results.success.push(formattedNumber);
            console.log('✅ Message sent to:', formattedNumber);

        } catch (error) {
            console.error('Error for number:', number, error);
            results.failed.push({
                number,
                reason: error.message
            });
        }

        // Add a small delay between processing different numbers
        await delay(500);
    }

    res.json({ results });
});

app.post('/upload-media', (req, res) => {
    upload.single('media')(req, res, function(err) {
        if (err) {
            console.error('Upload error:', err);
            return res.status(400).json({ 
                error: 'خطأ في رفع الملف',
                details: err.message 
            });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم اختيار ملف' });
        }

        res.json({ 
            success: true,
            filePath: req.file.path,
            fileName: req.file.filename
        });
    });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
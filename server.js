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
        fileSize: 16 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const allowedMimes = [
            'image/jpeg', 'image/png', 'image/gif',
            'video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
            'audio/mp4', 'audio/aac', 'audio/x-m4a', 'application/ogg'
        ];
        if (allowedMimes.includes(file.mimetype) || 
            file.mimetype.startsWith('audio/') || 
            file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error(`نوع الملف غير مدعوم: ${file.mimetype}`));
        }
    }
});

app.use(cors({
    origin: 'https://whatsapp-f.vercel.app',
    methods: ['GET', 'POST'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://whatsapp-f.vercel.app');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use(express.json({ limit: '16mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));
app.use('/uploads', express.static('uploads'));

let client;
let connectionStatus = 'disconnected';
let qrCodeData = null;
let messageQueue = [];
let isProcessingQueue = false;

async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;
    console.log(`Processing message queue. Items: ${messageQueue.length}`);

    while (messageQueue.length > 0) {
        const task = messageQueue[0];
        try {
            const { number, message, mediaPaths } = task;
            console.log(`Processing message for number: ${number}`);

            const chatId = `${number}@c.us`;
            const isRegistered = await client.isRegisteredUser(chatId);
            
            if (!isRegistered) {
                throw new Error('رقم غير مسجل في واتساب');
            }

            if (mediaPaths && mediaPaths.length > 0) {
                for (const mediaPath of mediaPaths) {
                    const fullPath = path.join(process.cwd(), mediaPath);
                    if (!fs.existsSync(fullPath)) {
                        throw new Error('ملف الوسائط غير موجود');
                    }

                    const mimeType = mime.lookup(fullPath);
                    const base64Data = fs.readFileSync(fullPath, { encoding: 'base64' });
                    const media = new MessageMedia(mimeType, base64Data, path.basename(fullPath));

                    await client.sendMessage(chatId, media, {
                        sendMediaAsDocument: mimeType.startsWith('video/'),
                        caption: message
                    });
                }
            } else if (message) {
                await client.sendMessage(chatId, message);
            }

            task.resolve({ success: true, number });
        } catch (error) {
            console.error(`Error processing message for ${task.number}:`, error);
            task.reject({ success: false, number: task.number, error: error.message });
        }

        messageQueue.shift();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay between messages
    }

    isProcessingQueue = false;
}

async function ensureConnection() {
    if (!client?.isReady) {
        console.log('Client not ready, reinitializing...');
        await destroyClient();
        await clearAuthData();
        initializeWhatsApp();
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 30000);

            client.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }
    return Promise.resolve();
}

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
        const authDir = path.join(process.cwd(), '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Error clearing auth data:', error);
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

    client.on('loading_screen', (percent, message) => {
        connectionStatus = `connecting:${percent}`;
        console.log('Loading:', percent, '%', message);
    });

    client.on('ready', () => {
        connectionStatus = 'connected';
        qrCodeData = null;
        console.log('WhatsApp client is ready!');
        processMessageQueue(); // Start processing any pending messages
    });

    client.on('authenticated', () => {
        connectionStatus = 'authenticating';
        console.log('WhatsApp authenticated successfully!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        connectionStatus = 'disconnected';
    });

    client.on('disconnected', async () => {
        console.log('WhatsApp disconnected!');
        await destroyClient();
        await clearAuthData();
        messageQueue = []; // Clear the queue on disconnect
        initializeWhatsApp();
    });

    try {
        client.initialize().catch(error => {
            console.error('Error during initialization:', error);
            connectionStatus = 'disconnected';
        });
    } catch (error) {
        console.error('Error initializing client:', error);
        connectionStatus = 'disconnected';
    }
}

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
        messageQueue = []; // Clear the queue on disconnect
        connectionStatus = 'initializing';
        initializeWhatsApp();
        res.json({ 
            success: true, 
            message: 'Disconnected successfully',
            status: connectionStatus
        });
    } catch (error) {
        console.error('Error during disconnect:', error);
        connectionStatus = 'initializing';
        qrCodeData = null;
        initializeWhatsApp();
        res.json({ 
            success: true, 
            message: 'Disconnected with recovery',
            status: connectionStatus
        });
    }
});

app.post('/send-bulk-messages', async (req, res) => {
    try {
        await ensureConnection();
        
        const { numbers, message, mediaPaths } = req.body;
        console.log('Received request:', { numbers, message, mediaPaths });

        if (!client?.isReady) {
            return res.status(400).json({ error: 'WhatsApp client not initialized' });
        }

        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'يجب توفير قائمة صالحة من الأرقام' });
        }

        const results = { success: [], failed: [] };
        const promises = numbers.map(number => {
            let formattedNumber = number.toString().replace(/\D/g, '');
            if (!formattedNumber.startsWith('20')) {
                formattedNumber = '20' + formattedNumber;
            }

            return new Promise((resolve, reject) => {
                messageQueue.push({
                    number: formattedNumber,
                    message,
                    mediaPaths,
                    resolve,
                    reject
                });
            });
        });

        // Start processing the queue if it's not already running
        processMessageQueue();

        // Wait for all messages to be processed
        const messageResults = await Promise.allSettled(promises);

        messageResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value.success) {
                results.success.push(result.value.number);
            } else {
                results.failed.push({
                    number: result.reason.number,
                    reason: result.reason.error
                });
            }
        });

        res.json({ results });

    } catch (error) {
        console.error('Main error:', error);
        res.status(500).json({ error: 'خطأ في معالجة الطلب: ' + error.message });
    }
});

app.post('/upload-media', upload.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'لم يتم اختيار ملف' });
    }

    res.json({ 
        success: true,
        filePath: req.file.path,
        fileName: req.file.filename,
        mimeType: req.file.mimetype
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
    res.json({ 
        status: 'Server is running',
        endpoints: {
            status: '/status',
            disconnect: '/disconnect',
            sendBulkMessages: '/send-bulk-messages',
            uploadMedia: '/upload-media',
            health: '/health'
        }
    });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;
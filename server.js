const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище комнат
const rooms = new Map();

// Хранение WebSocket соединений по userId
const userConnections = new Map();

wss.on('connection', (ws) => {
    console.log('Новое подключение');
    let currentUserId = null;
    let currentRoomId = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Получено сообщение:', data.type);
            
            switch(data.type) {
                case 'join':
                    const result = handleJoin(ws, data);
                    if (result) {
                        currentUserId = result.userId;
                        currentRoomId = result.roomId;
                        userConnections.set(currentUserId, ws);
                    }
                    break;
                case 'offer':
                case 'answer':
                case 'candidate':
                    forwardToPeer(data);
                    break;
                case 'message':
                    forwardMessage(data);
                    break;
                case 'leave':
                    handleLeave(data);
                    break;
            }
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('Клиент отключился');
        
        // Очистка при отключении
        if (currentUserId && currentRoomId) {
            handleUserDisconnect(currentUserId, currentRoomId);
            userConnections.delete(currentUserId);
        }
    });
    
    // Отправляем ping для проверки соединения
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);
    
    ws.on('pong', () => {
        // Клиент ответил на ping
    });
    
    ws.on('close', () => {
        clearInterval(pingInterval);
    });
});

function handleJoin(ws, data) {
    const { roomId, token, maxUsers } = data;
    
    // Проверяем токен
    if (token !== 'secret123') {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Неверный токен' 
        }));
        return null;
    }
    
    let room = rooms.get(roomId);
    
    // Если комната не существует, создаем
    if (!room) {
        room = {
            id: roomId,
            maxUsers: Math.min(maxUsers || 6, 6), // Максимум 6
            users: [],
            creationTime: Date.now()
        };
        rooms.set(roomId, room);
        console.log(`Создана комната ${roomId} на ${room.maxUsers} человек`);
    }
    
    // Проверяем количество пользователей
    if (room.users.length >= room.maxUsers) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Комната переполнена' 
        }));
        return null;
    }
    
    // Создаем пользователя
    const userId = generateUserId();
    const user = {
        id: userId,
        ws: ws,
        joinTime: Date.now()
    };
    
    room.users.push(user);
    
    console.log(`Пользователь ${userId} присоединился к комнате ${roomId}. Всего: ${room.users.length}/${room.maxUsers}`);
    
    // Отправляем подтверждение
    ws.send(JSON.stringify({
        type: 'joined',
        userId: userId,
        users: room.users.map(u => u.id),
        roomId: roomId,
        maxUsers: room.maxUsers
    }));
    
    // Уведомляем других о новом пользователе
    broadcastToRoom(roomId, {
        type: 'user_joined',
        userId: userId,
        users: room.users.map(u => u.id)
    }, ws);
    
    return { userId, roomId };
}

function forwardToPeer(data) {
    const { targetUserId, ...message } = data;
    
    const targetWs = userConnections.get(targetUserId);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(message));
    } else {
        console.log(`Пользователь ${targetUserId} не найден или не в сети`);
    }
}

function forwardMessage(data) {
    const { targetUserId, text, senderId } = data;
    
    const targetWs = userConnections.get(targetUserId);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: 'message',
            text: text,
            senderId: senderId
        }));
    }
}

function handleLeave(data) {
    const { roomId, userId } = data;
    handleUserDisconnect(userId, roomId);
}

function handleUserDisconnect(userId, roomId) {
    const room = rooms.get(roomId);
    
    if (room) {
        const userIndex = room.users.findIndex(u => u.id === userId);
        if (userIndex !== -1) {
            room.users.splice(userIndex, 1);
            
            console.log(`Пользователь ${userId} покинул комнату ${roomId}. Осталось: ${room.users.length}`);
            
            // Уведомляем остальных
            broadcastToRoom(roomId, {
                type: 'user_left',
                userId: userId,
                users: room.users.map(u => u.id)
            });
            
            // Если комната пуста, удаляем её через некоторое время
            if (room.users.length === 0) {
                setTimeout(() => {
                    if (rooms.has(roomId) && rooms.get(roomId).users.length === 0) {
                        rooms.delete(roomId);
                        console.log(`Комната ${roomId} удалена за неактивностью`);
                    }
                }, 60000); // Удаляем через минуту
            }
        }
    }
}

function broadcastToRoom(roomId, message, excludeWs = null) {
    const room = rooms.get(roomId);
    if (room) {
        const messageStr = JSON.stringify(message);
        room.users.forEach(user => {
            if (user.ws !== excludeWs && user.ws.readyState === WebSocket.OPEN) {
                user.ws.send(messageStr);
            }
        });
    }
}

function generateUserId() {
    return 'user_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Очистка старых комнат
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms.entries()) {
        if (room.users.length === 0 && now - room.creationTime > 3600000) {
            rooms.delete(roomId);
            console.log(`Комната ${roomId} удалена (старая)`);
        }
    }
}, 300000); // Проверка каждые 5 минут

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сигнальный сервер запущен на порту ${PORT}`);
    console.log(`WebSocket URL: wss://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}:${PORT}`);
});
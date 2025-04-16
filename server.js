import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import csv from 'csv-parser';
import bcrypt from 'bcrypt';
import cookie from 'cookie';

const PORT = 3000;
const BASE_DIR = path.resolve('C:\\Users\\Ceriello Francesco\\projects\\informatica\\Personale\\infoBanca\\pubblico');
const DATA_DIR = path.resolve('C:\\Users\\Ceriello Francesco\\projects\\informatica\\Personale\\infoBanca\\data');
const IMMAGINI_DIR = path.resolve(BASE_DIR, 'immagini');

const SESSION_TIMEOUT = 3600000; // 1h
const sessions = {};

function serveFile(filePath, contentType, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('File non trovato');
        }
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        res.end(data);
    });
}

function generateToken() {
    return Math.random().toString(36).substring(2);
}

function startSession(username) {
    const token = generateToken();
    sessions[token] = { username, timestamp: Date.now() };
    return token;
}

function checkSession(token) {
    const session = sessions[token];
    if (!session || Date.now() - session.timestamp > SESSION_TIMEOUT) {
        delete sessions[token];
        return false;
    }
    session.timestamp = Date.now();
    return true;
}

function generateCardData() {
    const number = Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join('').replace(/(.{4})/g, '$1 ').trim();
    const cvv = ('' + Math.floor(100 + Math.random() * 900));
    const now = new Date();
    const expiration = `${String(now.getMonth() + 1).padStart(2, '0')}/${(now.getFullYear() + 3).toString().slice(-2)}`;
    return { number, cvv, expiration };
}

const requestHandler = (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies.session_token;

    console.log(`🔹 Richiesta: ${pathname}`);

    const isPublicRoute = ['/banca.html', '/login.html', '/registrazione.html', '/login', '/register'].includes(pathname) || pathname.startsWith('/immagini/');
    const isStaticFile = fs.existsSync(path.join(BASE_DIR, pathname));

    if (!token && !isPublicRoute) {
        res.writeHead(302, { Location: '/banca.html' });
        return res.end();
    }

    if (token && !checkSession(token)) {
        res.setHeader('Set-Cookie', cookie.serialize('session_token', '', { maxAge: 0, path: '/' }));
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
    }

    if (isStaticFile) {
        const filePath = pathname.startsWith('/immagini/')
            ? path.join(IMMAGINI_DIR, pathname.replace('/immagini/', ''))
            : path.join(BASE_DIR, pathname);

        const ext = path.extname(filePath).toLowerCase();
        const mime = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp'
        };

        return serveFile(filePath, mime[ext] || 'application/octet-stream', res);
    }

    if (pathname === '/register' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { username, nome, cognome, email, password, dataDiNascita, tipoConto } = data;

                if (!username || !nome || !cognome || !email || !password || !dataDiNascita) {
                    return res.writeHead(400).end(JSON.stringify({ success: false, message: 'Campi mancanti.' }));
                }

                const users = [];
                const filePath = path.join(DATA_DIR, 'all_users_registration.csv');
                const exists = fs.existsSync(filePath);

                if (exists) {
                    await new Promise(resolve => {
                        fs.createReadStream(filePath)
                            .pipe(csv({ separator: ',' }))
                            .on('data', row => users.push(row))
                            .on('end', resolve);
                    });

                    if (users.some(u => u.Username === username)) {
                        return res.writeHead(400).end(JSON.stringify({ success: false, message: 'Username già esistente.' }));
                    }
                }

                const hashed = await bcrypt.hash(password, 10);
                const numeroConto = 'IT' + Math.floor(Math.random() * 10000000000);
                const saldo = 0;
                const { number, cvv, expiration } = generateCardData();

                const newRow = [
                    username, nome, cognome, email, password, hashed, dataDiNascita,
                    numeroConto, saldo, tipoConto || 'default',
                    '', '', '', '', '',
                    number, cvv, expiration
                ].join(',');

                const header = 'Username,Nome,Cognome,Email,Password,HashPassword,Data di Nascita,NumeroConto,Saldo,ContoTipo,ImportoPrestito,Durata,InteresseTotale,Totale,RataMensile,NumeroCarta,CVV,Scadenza\n';

                fs.appendFile(filePath, (exists ? '' : header) + newRow + '\n', err => {
                    if (err) return res.writeHead(500).end(JSON.stringify({ success: false, message: 'Errore durante la scrittura.' }));

                    const sessionToken = startSession(username);
                    res.setHeader('Set-Cookie', cookie.serialize('session_token', sessionToken, { httpOnly: true, path: '/', maxAge: SESSION_TIMEOUT / 1000 }));
                    return res.writeHead(200).end(JSON.stringify({ success: true, message: 'Registrazione completata.' }));
                });
            } catch (err) {
                res.writeHead(400).end(JSON.stringify({ success: false, message: 'Dati non validi.' }));
            }
        });
        return;
    }

    if (pathname === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            const { username, password } = JSON.parse(body);
            const users = [];

            fs.createReadStream(path.join(DATA_DIR, 'all_users_registration.csv'))
                .pipe(csv({ separator: ',' }))
                .on('data', row => users.push(row))
                .on('end', () => {
                    const user = users.find(u => u.Username === username);
                    if (!user) return res.writeHead(401).end(JSON.stringify({ success: false, message: 'Credenziali non valide.' }));

                    bcrypt.compare(password, user.HashPassword, (err, match) => {
                        if (!match || err) return res.writeHead(401).end(JSON.stringify({ success: false, message: 'Credenziali non valide.' }));

                        const sessionToken = startSession(username);
                        res.setHeader('Set-Cookie', cookie.serialize('session_token', sessionToken, { httpOnly: true, path: '/', maxAge: SESSION_TIMEOUT / 1000 }));
                        return res.writeHead(200).end(JSON.stringify({ success: true, redirect: '/dashboard.html' }));
                    });
                });
        });
        return;
    }

    if (pathname === "/getContoInfo" && req.method === "GET") {
        if (!checkSession(token)) {
            res.writeHead(401).end(JSON.stringify({ success: false, message: "Accesso non autorizzato" }));
            return;
        }

        const username = sessions[token].username;
        const users = [];

        fs.createReadStream(path.join(DATA_DIR, 'all_users_registration.csv'))
            .pipe(csv({ separator: ',' }))
            .on('data', row => users.push(row))
            .on('end', () => {
                const user = users.find(u => u.Username === username);
                if (!user) return res.writeHead(404).end(JSON.stringify({ success: false, message: "Utente non trovato" }));

                res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
                    success: true,
                    nome: user.Nome,
                    numeroConto: user.NumeroConto,
                    saldo: parseFloat(user.Saldo),
                    numeroCarta: user.NumeroCarta,
                    cvv: user.CVV,
                    scadenza: user.Scadenza,
                    importoPrestito: parseFloat(user.ImportoPrestito || 0),
                    rataMensile: parseFloat(user.RataMensile || 0)
                }));
            });
        return;
    }

    // ✅ /salvaPrestito aggiornata: salva anche nei movimenti
  if (pathname === '/salvaPrestito' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        if (!checkSession(token)) return res.writeHead(401).end(JSON.stringify({ success: false, message: 'Accesso non autorizzato.' }));

        const { importo, durata, interesseTotale, totale, rataMensile } = JSON.parse(body);
        const username = sessions[token].username;
        const users = [];

        fs.createReadStream(path.join(DATA_DIR, 'all_users_registration.csv'))
            .pipe(csv({ separator: ',' }))
            .on('data', row => users.push(row))
            .on('end', () => {
                const index = users.findIndex(u => u.Username === username);
                if (index === -1) return res.writeHead(404).end(JSON.stringify({ success: false, message: 'Utente non trovato' }));

                // ✅ Aggiorniamo anche il saldo
                const saldoAttuale = parseFloat(users[index].Saldo || 0);
                users[index].Saldo = saldoAttuale + parseFloat(importo);

                // Aggiorna anche i dati del prestito
                users[index] = {
                    ...users[index],
                    ImportoPrestito: importo,
                    Durata: durata,
                    InteresseTotale: interesseTotale,
                    Totale: totale,
                    RataMensile: rataMensile
                };

                const header = 'Username,Nome,Cognome,Email,Password,HashPassword,Data di Nascita,NumeroConto,Saldo,ContoTipo,ImportoPrestito,Durata,InteresseTotale,Totale,RataMensile,NumeroCarta,CVV,Scadenza\n';
                const content = users.map(u => Object.values(u).join(',')).join('\n');

                fs.writeFile(path.join(DATA_DIR, 'all_users_registration.csv'), header + content + '\n', 'utf8', err => {
                    if (err) return res.writeHead(500).end(JSON.stringify({ success: false, message: 'Errore salvataggio.' }));

                    // 👇 Salvataggio come movimento
                    const data = new Date().toISOString().split('T')[0];
                    const descrizione = `Prestito di €${importo} per ${durata} mesi`;
                    const movimento = `${username},${data},Prestito,${descrizione},${importo}\n`;
                    const movimentiPath = path.join(DATA_DIR, 'movimenti.csv');
                    const movimentiHeader = 'Username,Data,Tipo,Descrizione,Importo\n';

                    fs.appendFile(movimentiPath, (fs.existsSync(movimentiPath) ? '' : movimentiHeader) + movimento, err2 => {
                        if (err2) return res.writeHead(500).end(JSON.stringify({ success: false, message: 'Errore nel salvataggio del movimento.' }));

                        res.writeHead(200).end(JSON.stringify({ success: true, message: 'Prestito salvato, saldo aggiornato e movimento registrato.' }));
                    });
                });
            });
    });
    return;
}

    if (pathname === '/logout' && req.method === 'GET') {
        if (token) delete sessions[token];
        res.setHeader('Set-Cookie', cookie.serialize('session_token', '', { maxAge: 0, path: '/' }));
        res.writeHead(200).end(JSON.stringify({ success: true, message: 'Logout completato.' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Endpoint non trovato');
};

http.createServer(requestHandler).listen(PORT, () => {
    console.log(`🚀 Server attivo su http://localhost:${PORT}`);
});

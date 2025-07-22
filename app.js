const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const port = 3000;
const saltRounds = 10;

// --- ↓↓↓ セッションの設定を更新！ ↓↓↓ ---
app.use(session({
    secret: 'your_secret_key_2025', // 秘密鍵はもっと複雑なものにしよう
    resave: false,
    saveUninitialized: false, // ログインしない限りセッションを作らない
    cookie: {
        secure: false, // HTTPSでない場合はfalse
        maxAge: 1000 * 60 * 60 * 24 * 14 // 14日間有効
    }
}));
// --- ↑↑↑ ここまで ↑↑↑ ---

// データベースの設定
const db = new sqlite3.Database('./ifindu.db', (err) => {
    if (err) { console.error(err.message); }
    console.log('Connected to the ifindu database.');
});

// テーブル作成
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        slack_id TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        skills_required TEXT NOT NULL,
        creator_id INTEGER NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_id) REFERENCES users (id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        applicant_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        FOREIGN KEY (project_id) REFERENCES projects (id),
        FOREIGN KEY (applicant_id) REFERENCES users (id)
    )`);
});


// ミドルウェアの設定
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// 全てのルートでユーザー情報をテンプレートに渡すミドルウェア
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user;
    next();
});

// --- ルーティング ---

// トップページ
app.get('/', (req, res) => {
    const sql = "SELECT projects.*, users.username as creator_name FROM projects JOIN users ON projects.creator_id = users.id ORDER BY projects.created_at DESC LIMIT 3";
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error(err.message);
            return res.render('index', { projects: [] });
        }
        res.render('index', { projects: rows });
    });
});

// プロジェクト一覧ページ
app.get('/project_search', (req, res) => {
    let sql = "SELECT projects.*, users.username as creator_name FROM projects JOIN users ON projects.creator_id = users.id";
    const params = [];
    if (req.query.category && req.query.category !== '全て') {
        sql += " WHERE category = ?";
        params.push(req.query.category);
    }
    sql += " ORDER BY projects.created_at DESC";

    db.all(sql, params, (err, rows) => {
        if (err) { throw err; }
        res.render('project_search', { projects: rows, currentCategory: req.query.category || '全て' });
    });
});

// ユーザー登録ページ
app.get('/register', (req, res) => { res.render('register'); });
app.post('/register', async (req, res) => {
    const { username, email, password, slack_id } = req.body;

    // --- ↓↓↓ 必須項目のチェックを追加！ ↓↓↓ ---
    if (!username || !email || !password || !slack_id) {
        // もしどれか一つでも空なら、エラーメッセージと共に登録ページに戻す（今回はシンプルにリダイレクト）
        return res.redirect('/register');
    }
    // --- ↑↑↑ ここまで ↑↑↑ ---

    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const sql = 'INSERT INTO users (username, email, password, slack_id) VALUES (?, ?, ?, ?)';
    db.run(sql, [username, email, hashedPassword, slack_id], function(err) {
        if (err) {
            console.error(err.message);
            return res.redirect('/register');
        }
        res.redirect('/login');
    });
});

// ログインページ
app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM users WHERE email = ?';
    db.get(sql, [email], async (err, user) => {
        if (err || !user || !await bcrypt.compare(password, user.password)) {
            return res.redirect('/login');
        }
        req.session.user = { id: user.id, username: user.username, slack_id: user.slack_id };
        res.redirect('/dashboard');
    });
});

// ログアウト
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) { return res.redirect('/'); }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

// プロジェクト作成ページ
app.get('/create', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    res.render('create_project');
});
app.post('/create', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const { title, description, category, skills } = req.body;
    const skillsString = Array.isArray(skills) ? skills.join(', ') : (skills || '');
    const sql = 'INSERT INTO projects (title, description, category, skills_required, creator_id) VALUES (?, ?, ?, ?, ?)';
    db.run(sql, [title, description, category, skillsString, req.session.user.id], function(err) {
        if (err) { return console.log(err.message); }
        res.redirect('/');
    });
});

// プロジェクト詳細ページ
app.get('/projects/:id', (req, res) => {
    const sql = "SELECT projects.*, users.username as creator_name FROM projects JOIN users ON projects.creator_id = users.id WHERE projects.id = ?";
    db.get(sql, [req.params.id], (err, project) => {
        if (err || !project) { return res.redirect('/'); }
        res.render('project_detail', { project: project });
    });
});

// 参加リクエスト処理
app.post('/projects/:id/apply', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = 'INSERT INTO requests (project_id, applicant_id) VALUES (?, ?)';
    db.run(sql, [req.params.id, req.session.user.id], function(err) {
        if (err) { console.error(err.message); }
        res.redirect('/dashboard');
    });
});

// ダッシュボード
app.get('/dashboard', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }

    const myProjectsSql = "SELECT * FROM projects WHERE creator_id = ?";
    const receivedRequestsSql = `
        SELECT requests.*, projects.title, users.username as applicant_name, users.slack_id as applicant_slack_id
        FROM requests
        JOIN projects ON requests.project_id = projects.id
        JOIN users ON requests.applicant_id = users.id
        WHERE projects.creator_id = ?`;
    const sentRequestsSql = `
        SELECT requests.*, projects.title, users.username as creator_name, users.slack_id as creator_slack_id
        FROM requests
        JOIN projects ON requests.project_id = projects.id
        JOIN users ON projects.creator_id = users.id
        WHERE requests.applicant_id = ?`;
    
    db.all(myProjectsSql, [req.session.user.id], (err, myProjects) => {
    db.all(receivedRequestsSql, [req.session.user.id], (err, receivedRequests) => {
    db.all(sentRequestsSql, [req.session.user.id], (err, sentRequests) => {
        res.render('dashboard', { myProjects, receivedRequests, sentRequests });
    });});});
});

// リクエスト承認処理
app.post('/requests/:id/approve', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = "UPDATE requests SET status = 'approved' WHERE id = ?";
    db.run(sql, [req.params.id], function(err) {
        if (err) { console.error(err.message); }
        res.redirect('/dashboard');
    });
});


// サーバーの起動
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
});
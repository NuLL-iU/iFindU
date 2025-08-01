const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const port = 3000;
const saltRounds = 10;

const isProduction = process.env.FLY_APP_NAME !== undefined;

app.use(session({
    store: new SQLiteStore({
        db: 'ifindu.db',
        dir: isProduction ? '/data' : '.'
    }),
    secret: 'your_secret_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: 'auto',
        maxAge: 1000 * 60 * 60 * 24 * 14
    }
}));

const dbPath = isProduction ? '/data/ifindu.db' : './ifindu.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error(err.message); }
    console.log(`Connected to the database at ${dbPath}`);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        slack_id TEXT NOT NULL,
        university TEXT NOT NULL 
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

app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.locals.currentUser = req.session.user;
    next();
});

// --- ルーティング ---

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

app.get('/register', (req, res) => { res.render('register'); });
app.post('/register', async (req, res) => {
    const { username, email, password, slack_id, university } = req.body;
    if (!username || !email || !password || !slack_id || !university) {
        return res.redirect('/register');
    }
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    const sql = 'INSERT INTO users (username, email, password, slack_id, university) VALUES (?, ?, ?, ?, ?)';
    db.run(sql, [username, email, hashedPassword, slack_id, university], function(err) {
        if (err) {
            console.error(err.message);
            return res.redirect('/register');
        }
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => { res.render('login'); });
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM users WHERE email = ?';
    db.get(sql, [email], async (err, user) => {
        if (err || !user || !await bcrypt.compare(password, user.password)) {
            return res.redirect('/login');
        }
        req.session.user = { id: user.id, username: user.username };
        res.redirect('/dashboard');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) { return res.redirect('/'); }
        res.clearCookie('connect.sid');
        res.redirect('/');
    });
});

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

// --- ↓↓↓ project_detail のSQLに university を追加！ ↓↓↓ ---
app.get('/projects/:id', (req, res) => {
    const sql = "SELECT projects.*, users.username as creator_name, users.university as creator_university FROM projects JOIN users ON projects.creator_id = users.id WHERE projects.id = ?";
    db.get(sql, [req.params.id], (err, project) => {
        if (err || !project) { return res.redirect('/'); }
        res.render('project_detail', { project: project });
    });
});

app.post('/projects/:id/apply', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = 'INSERT INTO requests (project_id, applicant_id) VALUES (?, ?)';
    db.run(sql, [req.params.id, req.session.user.id], function(err) {
        if (err) { console.error(err.message); }
        res.redirect('/dashboard');
    });
});

app.get('/projects/:id/edit', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = "SELECT * FROM projects WHERE id = ?";
    db.get(sql, [req.params.id], (err, project) => {
        if (err || !project) { return res.redirect('/'); }
        if (project.creator_id !== req.session.user.id) {
            return res.redirect('/');
        }
        res.render('edit_project', { project: project });
    });
});

app.post('/projects/:id/edit', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const { title, description, category, skills } = req.body;
    const skillsString = Array.isArray(skills) ? skills.join(', ') : (skills || '');
    
    const checkSql = "SELECT creator_id FROM projects WHERE id = ?";
    db.get(checkSql, [req.params.id], (err, project) => {
        if (err || !project || project.creator_id !== req.session.user.id) {
            return res.redirect('/');
        }
        const updateSql = `UPDATE projects SET title = ?, description = ?, category = ?, skills_required = ? WHERE id = ?`;
        db.run(updateSql, [title, description, category, skillsString, req.params.id], function(err) {
            if (err) { return console.log(err.message); }
            res.redirect(`/projects/${req.params.id}`);
        });
    });
});

app.post('/projects/:id/delete', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const checkSql = "SELECT creator_id FROM projects WHERE id = ?";
    db.get(checkSql, [req.params.id], (err, project) => {
        if (err || !project || project.creator_id !== req.session.user.id) {
            return res.redirect('/');
        }
        const deleteSql = "DELETE FROM projects WHERE id = ?";
        db.run(deleteSql, [req.params.id], function(err) {
            if (err) { return console.log(err.message); }
            res.redirect('/dashboard');
        });
    });
});

// --- ↓↓↓ プロフィール編集機能を追加！ ↓↓↓ ---
app.get('/profile/edit', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = "SELECT id, username, email, slack_id, university FROM users WHERE id = ?";
    db.get(sql, [req.session.user.id], (err, user) => {
        if (err || !user) { return res.redirect('/'); }
        res.render('edit_profile', { user: user });
    });
});

app.post('/profile/edit', async (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const { username, email, slack_id, university, password } = req.body;

    // パスワードが入力された場合のみ、パスワードも更新する
    if (password) {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const sql = `UPDATE users SET username = ?, email = ?, slack_id = ?, university = ?, password = ? WHERE id = ?`;
        db.run(sql, [username, email, slack_id, university, hashedPassword, req.session.user.id], function(err) {
            if (err) { console.error(err.message); }
            // セッション情報も更新
            req.session.user.username = username;
            res.redirect('/dashboard');
        });
    } else {
        // パスワードが入力されなかった場合
        const sql = `UPDATE users SET username = ?, email = ?, slack_id = ?, university = ? WHERE id = ?`;
        db.run(sql, [username, email, slack_id, university, req.session.user.id], function(err) {
            if (err) { console.error(err.message); }
            // セッション情報も更新
            req.session.user.username = username;
            res.redirect('/dashboard');
        });
    }
});
// --- ↑↑↑ ここまで ---

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

app.post('/requests/:id/approve', (req, res) => {
    if (!req.session.user) { return res.redirect('/login'); }
    const sql = "UPDATE requests SET status = 'approved' WHERE id = ?";
    db.run(sql, [req.params.id], function(err) {
        if (err) { console.error(err.message); }
        res.redirect('/dashboard');
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
});
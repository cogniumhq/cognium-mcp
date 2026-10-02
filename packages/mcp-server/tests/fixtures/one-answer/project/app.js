// A small Express-shaped handler: one request parameter reaching a query.
const express = require('express');
const db = require('./db');

const app = express();

app.get('/users', (req, res) => {
  const id = req.query.id;
  db.query('SELECT * FROM users WHERE id = ' + id, (err, rows) => {
    res.json(rows);
  });
});

module.exports = app;

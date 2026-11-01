CREATE TABLE customers (id integer PRIMARY KEY, name text, email text, password_md5 text);
INSERT INTO customers VALUES (1, 'Dana Whitfield', 'dana.whitfield@example.com', '5f4dcc3b5aa765d61d8327deb882cf99');
INSERT INTO customers VALUES (2, 'Marco Ibarra', 'm.ibarra@example.net', 'e10adc3949ba59abbe56e057f20f883e');
CREATE TABLE staff (id integer PRIMARY KEY, login text, password_md5 text);
INSERT INTO staff VALUES (1, 'admin', '21232f297a57a5a743894a0e4a801fc3');

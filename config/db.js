import sql from "mssql";
import dotenv from "dotenv";
dotenv.config();

const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  // port: 27017,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  }
};

const poolPromise = new sql.ConnectionPool(dbConfig)
  .connect()
  .then(pool => {
    return pool;
  })
  .catch(err => {
    console.error("Database connection failed:", err);
    process.exit(1);
  });

export { poolPromise, sql };

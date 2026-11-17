import dotenv from "dotenv";
import sql from "mssql";
import net from "net";
dotenv.config();

const dbConfig = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  port: 27017,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    enableArithAbort: true,
    // tedious >= 19 rejects an IP address as the TLS server name
    ...(net.isIP(process.env.DB_SERVER || "") ? { serverName: "localhost" } : {}),
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

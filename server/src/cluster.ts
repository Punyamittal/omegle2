import cluster from 'cluster';
import os from 'os';

const numCPUs = parseInt(process.env.CLUSTER_WORKERS || '0', 10) || Math.max(1, os.cpus().length - 1);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);
  console.log(`Forking ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died (${code || signal}). Restarting...`);
    cluster.fork();
  });
} else {
  require('./index');
  console.log(`Worker ${process.pid} started`);
}

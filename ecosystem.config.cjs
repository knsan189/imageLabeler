module.exports = {
  apps: [
    {
      name: 'image-labeler',
      script: 'npm run start',
      // instances: 'max', // CPU 코어 수만큼 인스턴스 생성
      // exec_mode: 'cluster', // 클러스터 모드

      env_production: {
        NODE_ENV: 'production',
        PORT: 7771,
      },
      // 로그 설정
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true, // 로그에 타임스탬프 추가
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true, // 클러스터 모드에서 로그 병합

      // 자동 재시작 설정
      autorestart: true,
      watch: false, // 프로덕션에서는 watch 비활성화
      max_memory_restart: '1G', // 메모리 사용량이 1GB 초과 시 재시작

      // 재시작 지연
      min_uptime: '10s', // 최소 10초 이상 실행되어야 정상으로 간주
      max_restarts: 10, // 10초 내 재시작 횟수 제한
      restart_delay: 4000, // 재시작 전 4초 대기

      // 크래시 리포트
      exp_backoff_restart_delay: 100, // 지수 백오프 재시작 지연

      // 그레이스풀 셧다운
      kill_timeout: 5000, // SIGTERM 후 5초 대기 후 SIGKILL
      listen_timeout: 3000, // 앱이 리스닝을 시작할 때까지 대기 시간
      shutdown_with_message: true, // 그레이스풀 셧다운 활성화
    },
  ],
};

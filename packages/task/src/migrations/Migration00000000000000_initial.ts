import { Migration } from "@mikro-orm/migrations";

export class Migration00000000000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'create table `tasks` (`id` text not null, `agent` text not null, `runtime` text null, `status` text not null, `brief` text not null, `details` text null, `origin` text not null, `created_at` text not null, `started_at` text not null, `ended_at` text null, `success` json null, `failure` json null, `cancellation` json null, `metadata` json not null, primary key (`id`));',
    );
    this.addSql('create index `tasks_agent_idx` on `tasks` (`agent`);');
    this.addSql('create index `tasks_runtime_idx` on `tasks` (`runtime`);');
    this.addSql('create index `tasks_status_idx` on `tasks` (`status`);');
    this.addSql('create index `tasks_origin_idx` on `tasks` (`origin`);');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists `tasks`;');
  }
}

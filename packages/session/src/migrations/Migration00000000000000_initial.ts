import { Migration } from "@mikro-orm/migrations";

export class Migration00000000000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'create table `sessions` (`id` text not null, `agent` text not null, `runtime` text not null, `created_at` text not null, `runtime_session_id` text null, `last_launch_mode` text null, primary key (`id`));',
    );
    this.addSql('create index `sessions_agent_idx` on `sessions` (`agent`);');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists `sessions`;');
  }
}

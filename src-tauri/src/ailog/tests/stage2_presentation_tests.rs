use super::fixtures::Fixture;
use crate::ailog::{query, rollup, Filters, Range};
use rusqlite::{params, Connection};

const START: i64 = 1_789_398_000_000;

fn seed(connection: &Connection, session: &str, parent: Option<&str>, cost: f64, model: &str, state: &str) {
    connection.execute("INSERT INTO session(kind,session_id,parent_kind,parent_session_id,relationship_type,
        lineage_state,is_sidechain,cost_usd,started_at,ended_at,turn_count,ai_title,origin)
        VALUES ('codex',?1,?2,?3,?4,?5,?6,?7,?8,?8,1,?1,'unknown')",
        params![session,parent.map(|_|"codex"),parent,if parent.is_some(){"subagent"}else{"root"},
            if state=="legacy"{"legacy"}else{"verified"},parent.is_some(),cost,START]).unwrap();
    connection.execute("INSERT INTO turn(kind,session_id,seq,request_id,execution_key,usage_state,ts,model,
        model_family,input_tokens,output_tokens,cost_usd) VALUES ('codex',?1,0,?1,?1,?2,?3,?4,?4,100,10,?5)",
        params![session,state,START,model,cost]).unwrap();
}

fn range() -> Range { Range { from:Some(START-1),to:Some(START+1),..Default::default() } }
fn close(actual: f64, expected: f64) { assert!((actual-expected).abs()<1e-9,"{actual} != {expected}"); }

#[test]
fn stage2_display_toggle_keeps_parent_child_grandchild_totals_and_pages() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"parent",None,0.003,"gpt-6.1-sol","canonical");
    seed(&connection,"child",Some("parent"),0.006,"gpt-6-astra","canonical");
    seed(&connection,"grandchild",Some("child"),0.0015,"gpt-6-astra","canonical");
    for expanded in [false,true] {
        let filters=Filters { include_sidechain:expanded,..Default::default() };
        let overview=query::overview(&connection,&range(),&filters,START).unwrap();
        close(overview.totals.cost_usd,0.0105);close(overview.accounting.cost_usd,0.0105);
        let page=query::sessions(&connection,&range(),&filters,&query::SessionsOptions::default(),START).unwrap();
        assert_eq!(page.total,1);assert_eq!(page.rows.len(),if expanded{3}else{1});
        assert_eq!(page.rows[0].session_id,"parent");
        let shown=page.rows[0].presentation.as_ref().unwrap();
        close(shown.group_cost_usd,0.0105);close(shown.own_cost_usd,0.003);assert_eq!(shown.children_count,2);
        if expanded { assert_eq!(page.rows.iter().map(|row|row.presentation.as_ref().unwrap().depth).collect::<Vec<_>>(),vec![0,1,2]); }
    }
}

#[test]
fn stage2_claude_child_display_does_not_change_overview_or_series() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"parent",None,0.003,"claude-sonnet-5-5","canonical");
    seed(&connection,"child",Some("parent"),0.006,"claude-sonnet-5-5","canonical");
    connection.execute("UPDATE session SET kind='claude',parent_kind=CASE WHEN parent_kind IS NOT NULL THEN 'claude' END",[]).unwrap();
    connection.execute("UPDATE turn SET kind='claude'",[]).unwrap();
    for expanded in [false,true] {
        let filters=Filters {include_sidechain:expanded,..Default::default()};
        let overview=query::overview(&connection,&range(),&filters,START).unwrap();
        close(overview.totals.cost_usd,0.009);
        let series=query::series(&connection,&range(),&filters,&query::SeriesOptions::default(),START).unwrap();
        close(series.buckets.iter().flat_map(|bucket|&bucket.groups).map(|group|group.cost_usd).sum(),0.009);
        let sessions=query::sessions(&connection,&range(),&filters,&query::SessionsOptions::default(),START).unwrap();
        assert_eq!(sessions.rows.len(),if expanded{2}else{1});
    }
}

#[test]
fn stage2_model_filter_keeps_context_parent_without_adding_its_usage() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"parent",None,0.003,"gpt-6.1-sol","canonical");
    seed(&connection,"child",Some("parent"),0.006,"gpt-6-astra","canonical");
    let filters=Filters {models:vec!["gpt-6-astra".into()],include_sidechain:true,..Default::default()};
    let page=query::sessions(&connection,&range(),&filters,&query::SessionsOptions::default(),START).unwrap();
    assert_eq!(page.rows.len(),2);assert!(page.rows[0].presentation.as_ref().unwrap().context_only);
    close(page.rows[0].presentation.as_ref().unwrap().own_cost_usd,0.0);
    close(page.rows[0].presentation.as_ref().unwrap().group_cost_usd,0.006);
    close(query::overview(&connection,&range(),&filters,START).unwrap().totals.cost_usd,0.006);
    connection.execute("UPDATE turn SET ts=?1 WHERE session_id='parent'",[START-100]).unwrap();
    let page=query::sessions(&connection,&range(),&Filters::default(),&query::SessionsOptions::default(),START).unwrap();
    assert!(page.rows[0].presentation.as_ref().unwrap().context_only);
    close(page.rows[0].presentation.as_ref().unwrap().group_cost_usd,0.006);
}

#[test]
fn stage2_missing_parent_and_cycles_do_not_lose_or_repeat_usage() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"orphan",Some("absent"),0.003,"gpt-6.1-sol","canonical");
    seed(&connection,"cycle-a",Some("cycle-b"),0.006,"gpt-6.1-sol","canonical");
    seed(&connection,"cycle-b",Some("cycle-a"),0.0015,"gpt-6.1-sol","canonical");
    let page=query::sessions(&connection,&range(),&Filters {include_sidechain:true,..Default::default()},&query::SessionsOptions::default(),START).unwrap();
    assert_eq!(page.total,2);assert_eq!(page.rows.len(),3);
    let unique=page.rows.iter().map(|row|&row.session_id).collect::<std::collections::BTreeSet<_>>();assert_eq!(unique.len(),3);
    assert!(page.rows.iter().find(|row|row.session_id=="orphan").unwrap().presentation.as_ref().unwrap().parent_missing);
    assert!(page.rows.iter().find(|row|row.session_id=="cycle-a").unwrap().presentation.as_ref().unwrap().cycle);
    close(page.rows.iter().filter_map(|row|row.presentation.as_ref()).filter(|row|row.depth==0).map(|row|row.group_cost_usd).sum(),0.0105);
}

#[test]
fn stage2_pages_are_group_based_and_child_counts_do_not_change_total() {
    let fixture=Fixture::new();let connection=fixture.conn();
    for index in 0..101 {
        let parent=format!("parent-{index:03}");
        seed(&connection,&parent,None,0.003,"gpt-6.1-sol","canonical");
        seed(&connection,&format!("child-{index:03}"),Some(&parent),0.006,"gpt-6.1-sol","canonical");
    }
    let filters=Filters {include_sidechain:true,..Default::default()};
    let first=query::sessions(&connection,&range(),&filters,&query::SessionsOptions {sort:"cost".into(),limit:100,offset:0},START).unwrap();
    let last=query::sessions(&connection,&range(),&filters,&query::SessionsOptions {sort:"cost".into(),limit:100,offset:100},START).unwrap();
    assert_eq!(first.total,101);assert_eq!(last.total,101);assert_eq!(first.rows.len(),200);assert_eq!(last.rows.len(),2);
    assert!(!first.rows.iter().any(|row|row.session_id==last.rows[0].session_id));
}

#[test]
fn stage2_legacy_is_included_and_excluded_states_stay_out_of_detail_chart() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"legacy",None,0.003,"gpt-6.1-sol","legacy");
    for (sequence,state,cost) in [(1,"suspected_duplicate",0.006),(2,"duplicate",0.0015),(3,"unresolved",0.002)] {
        connection.execute("INSERT INTO turn(kind,session_id,seq,request_id,usage_state,ts,cost_usd)
            VALUES ('codex','legacy',?1,?2,?2,?3,?4)",params![sequence,state,START,cost]).unwrap();
    }
    let overview=query::overview(&connection,&range(),&Filters::default(),START).unwrap();
    close(overview.totals.cost_usd,0.003);close(overview.accounting.legacy_usd,0.003);
    close(overview.accounting.suspected_duplicate_usd,0.006);assert_eq!(overview.accounting.suspected_duplicate_rows,1);
    close(overview.accounting.confirmed_duplicate_usd,0.0015);close(overview.accounting.unresolved_usd,0.002);
    let detail=query::session_detail(&connection,"codex","legacy").unwrap();
    assert_eq!(detail.turns.len(),1);assert_eq!(detail.session.lineage.state,"legacy");
    close(detail.accounting.cost_usd,0.003);close(detail.accounting.unresolved_usd,0.002);
}

#[test]
fn stage2_accounting_rollup_matches_raw_for_states_filters_and_partial_days() {
    let fixture=Fixture::new();let connection=fixture.conn();
    for (session,state,cost) in [("root","canonical",0.003),("old","legacy",0.006),("suspect","suspected_duplicate",0.004),("copy","duplicate",0.002),("pending","unresolved",0.001)] {
        seed(&connection,session,None,cost,"gpt-6.1-sol",state);
        connection.execute("INSERT INTO turn(kind,session_id,seq,request_id,usage_state,ts,model,model_family,cost_usd)
            VALUES ('codex',?1,1,'edge',?2,?3,'gpt-6.1-sol','gpt-6.1-sol',?4)",params![session,state,START+86_400_000,cost]).unwrap();
    }
    let day=86_400_000;let start=(START+9*3_600_000)/day*day-9*3_600_000;
    let window=Range {from:Some(start-1),to:Some(start+day+43_200_000),..Default::default()};
    rollup::mark_all_dirty(&connection).unwrap();
    let raw=query::accounting_totals(&connection,&window,&Filters::default(),START).unwrap();
    let transaction=connection.unchecked_transaction().unwrap();rollup::rebuild_dirty(&transaction).unwrap();transaction.commit().unwrap();
    for expanded in [false,true] {
        let filters=Filters {include_sidechain:expanded,models:vec!["gpt-6.1-sol".into()],..Default::default()};
        let rolled=query::overview(&connection,&window,&filters,START).unwrap().accounting;
        assert_eq!(serde_json::to_value(&raw).unwrap(),serde_json::to_value(rolled).unwrap());
    }
}

#[test]
fn stage2_rollup_and_raw_match_for_display_modes() {
    let fixture=Fixture::new();let connection=fixture.conn();
    seed(&connection,"parent",None,0.003,"gpt-6.1-sol","canonical");
    seed(&connection,"child",Some("parent"),0.006,"gpt-6.1-sol","canonical");
    let day=86_400_000;let start=(START+9*3_600_000)/day*day-9*3_600_000;
    let window=Range {from:Some(start),to:Some(start+day-1),..Default::default()};
    rollup::mark_all_dirty(&connection).unwrap();
    let raw=query::sessions(&connection,&window,&Filters::default(),&query::SessionsOptions::default(),START).unwrap();
    assert_eq!(raw.total,1);
    let transaction=connection.unchecked_transaction().unwrap();rollup::mark_all_dirty(&transaction).unwrap();rollup::rebuild_dirty(&transaction).unwrap();transaction.commit().unwrap();
    for expanded in [false,true] {
        let filters=Filters {include_sidechain:expanded,..Default::default()};
        let rolled=query::sessions(&connection,&window,&filters,&query::SessionsOptions::default(),START).unwrap();
        assert_eq!(rolled.total,raw.total);close(rolled.rows[0].presentation.as_ref().unwrap().group_cost_usd,0.009);
        close(query::overview(&connection,&window,&filters,START).unwrap().totals.cost_usd,0.009);
    }
}

use std::{collections::BTreeSet, time::Duration};

/// Same 1/2/4/.../32 second restart policy as supervise.ps1. A sustained
/// successful run resets the failure streak; elapsed time is monotonic.
pub fn restart_delay(failures: &mut u32, uptime: Duration) -> Duration {
    *failures = if uptime > Duration::from_secs(60) {
        0
    } else {
        (*failures + 1).min(5)
    };
    Duration::from_secs(1 << *failures)
}

pub fn saved_roots(previous: &[String], loaded: Vec<String>, restore_failed: bool) -> Vec<String> {
    let mut roots: BTreeSet<_> = loaded.into_iter().collect();
    if restore_failed {
        roots.extend(previous.iter().cloned());
    }
    roots.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_bounded_and_resets_after_sustained_run() {
        let mut failures = 0;
        for seconds in [2, 4, 8, 16, 32, 32, 32] {
            assert_eq!(
                restart_delay(&mut failures, Duration::from_secs(3)),
                Duration::from_secs(seconds)
            );
        }
        assert_eq!(
            restart_delay(&mut failures, Duration::from_secs(61)),
            Duration::from_secs(1)
        );
    }

    #[test]
    fn failed_restoration_does_not_forget_unrestored_ids() {
        let previous = vec!["a".into(), "b".into()];
        let loaded = vec!["b".into(), "c".into(), "b".into()];
        assert_eq!(
            saved_roots(&previous, loaded.clone(), true),
            ["a", "b", "c"]
        );
        assert_eq!(saved_roots(&previous, loaded, false), ["b", "c"]);
    }
}

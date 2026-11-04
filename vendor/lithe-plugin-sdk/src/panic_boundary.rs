//! Suppresses payload printing only for panics owned by an SDK catch boundary.
use std::any::Any;
use std::cell::Cell;
use std::panic::{self, UnwindSafe};
use std::sync::Once;

thread_local! { static CAUGHT: Cell<bool> = const { Cell::new(false) }; }
static INSTALL: Once = Once::new();

pub(crate) fn catch<T>(
    operation: impl FnOnce() -> T + UnwindSafe,
) -> Result<T, Box<dyn Any + Send>> {
    INSTALL.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if !CAUGHT.with(Cell::get) {
                previous(info);
            }
        }));
    });
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            CAUGHT.with(|active| active.set(self.0));
        }
    }
    let _restore = Restore(CAUGHT.with(|active| active.replace(true)));
    panic::catch_unwind(operation)
}
